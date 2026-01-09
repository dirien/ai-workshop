import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as dockerBuild from "@pulumi/docker-build";

// Configuration
const config = new pulumi.Config();
const appName = "otel-ai-chatbot";
const environment = pulumi.getStack();

// Map stack name to NODE_ENV value
// dev → development, prod/production → production, default → production
const nodeEnv = environment === "dev" ? "development" : "production";

// Tags for all resources
const tags = {
    Environment: environment,
    Project: appName,
    ManagedBy: "Pulumi",
};

// =============================================================================
// ECR Repository and Docker Image
// =============================================================================

// Create ECR repository for application container (serves both frontend and backend)
const ecrRepository = new aws.ecr.Repository(`${appName}-app`, {
    name: `${appName}-app`,
    imageTagMutability: "MUTABLE",
    imageScanningConfiguration: {
        scanOnPush: true, // Enable vulnerability scanning
    },
    encryptionConfigurations: [{
        encryptionType: "AES256", // Server-side encryption
    }],
    forceDelete: true, // Allow deletion even with images (use cautiously in production)
    tags: tags,
});

// Create lifecycle policy to clean up old images
const lifecyclePolicy = new aws.ecr.LifecyclePolicy(`${appName}-lifecycle`, {
    repository: ecrRepository.name,
    policy: JSON.stringify({
        rules: [{
            rulePriority: 1,
            description: "Keep last 10 images",
            selection: {
                tagStatus: "any",
                countType: "imageCountMoreThan",
                countNumber: 10,
            },
            action: {
                type: "expire",
            },
        }],
    }),
});

// Get ECR authorization token
const authToken = aws.ecr.getAuthorizationTokenOutput({
    registryId: ecrRepository.registryId,
});

// Build and push Docker image
const image = new dockerBuild.Image(`${appName}-image`, {
    tags: [pulumi.interpolate`${ecrRepository.repositoryUrl}:${environment}`],
    push: true,
    context: {
        location: "../",
    },
    dockerfile: {
        location: "../Dockerfile",
    },
    platforms: ["linux/arm64"],
    buildArgs: {
        NODE_ENV: "production",
    },
    registries: [{
        address: ecrRepository.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
    }],
}, {dependsOn: [ecrRepository]});

// =============================================================================
// VPC and Networking
// =============================================================================

const vpc = new awsx.ec2.Vpc(`${appName}-vpc`, {
    cidrBlock: "10.0.0.0/16",
    numberOfAvailabilityZones: 2,
    natGateways: {
        strategy: "Single", // Use single NAT gateway to reduce costs
    },
    tags: tags,
});

// =============================================================================
// Security Groups
// =============================================================================

// ALB Security Group
const albSecurityGroup = new aws.ec2.SecurityGroup(`${appName}-alb-sg`, {
    vpcId: vpc.vpcId,
    description: "Security group for Application Load Balancer",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrBlocks: ["0.0.0.0/0"],
            description: "Allow HTTP from anywhere",
        },
        {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrBlocks: ["0.0.0.0/0"],
            description: "Allow HTTPS from anywhere",
        },
    ],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound traffic",
    }],
    tags: {...tags, Name: `${appName}-alb-sg`},
});

// ECS Tasks Security Group
const ecsSecurityGroup = new aws.ec2.SecurityGroup(`${appName}-ecs-sg`, {
    vpcId: vpc.vpcId,
    description: "Security group for ECS tasks",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 3001,
            toPort: 3001,
            securityGroups: [albSecurityGroup.id],
            description: "Allow traffic from ALB to application",
        },
    ],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound traffic",
    }],
    tags: {...tags, Name: `${appName}-ecs-sg`},
});

// OpenSearch Security Group
const openSearchSecurityGroup = new aws.ec2.SecurityGroup(`${appName}-opensearch-sg`, {
    vpcId: vpc.vpcId,
    description: "Security group for OpenSearch",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            securityGroups: [ecsSecurityGroup.id],
            description: "Allow HTTPS from ECS tasks",
        },
    ],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound traffic",
    }],
    tags: {...tags, Name: `${appName}-opensearch-sg`},
});

// =============================================================================
// IAM Roles
// =============================================================================

// ECS Task Execution Role
const ecsTaskExecutionRole = new aws.iam.Role(`${appName}-ecs-execution-role`, {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {Service: "ecs-tasks.amazonaws.com"},
            Action: "sts:AssumeRole",
        }],
    }),
    tags: tags,
});

new aws.iam.RolePolicyAttachment(`${appName}-ecs-execution-policy`, {
    role: ecsTaskExecutionRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// ECS Task Role (for application permissions)
const ecsTaskRole = new aws.iam.Role(`${appName}-ecs-task-role`, {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {Service: "ecs-tasks.amazonaws.com"},
            Action: "sts:AssumeRole",
        }],
    }),
    tags: tags,
});

// =============================================================================
// Secrets Manager
// =============================================================================

// Create secrets for API keys
const secretsManagerSecret = new aws.secretsmanager.Secret(`${appName}-secrets`, {
    description: "API keys and configuration for OpenTelemetry AI Chatbot",
    tags: tags,
});

// Note: OpenSearch password and Honeycomb API key - Bedrock uses IAM role for authentication
const secretVersion = new aws.secretsmanager.SecretVersion(`${appName}-secrets-version`, {
    secretId: secretsManagerSecret.id,
    secretString: pulumi.all([
        config.requireSecret("opensearchMasterPassword"),
        config.requireSecret("honeycombApiKey"),
    ]).apply(([opensearchPassword, honeycombApiKey]) => {
        const secretObj = {
            OPENSEARCH_PASSWORD: opensearchPassword,
            HONEYCOMB_API_KEY: honeycombApiKey,
            OTEL_EXPORTER_OTLP_HEADERS: `x-honeycomb-team=${honeycombApiKey}`,
        };
        return JSON.stringify(secretObj);
    }),
});

// Grant ECS task access to secrets
const secretsPolicy = new aws.iam.RolePolicy(`${appName}-secrets-policy`, {
    role: ecsTaskExecutionRole.id,
    policy: secretsManagerSecret.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "secretsmanager:GetSecretValue",
                "secretsmanager:DescribeSecret",
            ],
            Resource: arn,
        }],
    })),
});

// =============================================================================
// OpenSearch Domain
// =============================================================================

// OpenSearch Service Linked Role
// Note: This role is a singleton per AWS account. If you get an error that the role
// already exists, you can import it with:
// pulumi import aws:iam/serviceLinkedRole:ServiceLinkedRole opensearch-service-linked-role arn:aws:iam::<account-id>:role/aws-service-role/es.amazonaws.com/AWSServiceRoleForAmazonElasticsearchService
const opensearchSlr = new aws.iam.ServiceLinkedRole("opensearch-service-linked-role", {
    awsServiceName: "es.amazonaws.com"
});

const openSearchDomain = new aws.opensearch.Domain(`${appName}-opensearch`, {
    domainName: `${appName}-${environment}`,
    engineVersion: "OpenSearch_3.1",
    clusterConfig: {
        instanceType: "m8g.large.search",
        instanceCount: 2,
        dedicatedMasterEnabled: false,
        zoneAwarenessEnabled: false,
    },
    ebsOptions: {
        ebsEnabled: true,
        volumeSize: 100,
        volumeType: "gp3",
    },
    encryptAtRest: {
        enabled: true,
    },
    nodeToNodeEncryption: {
        enabled: true,
    },
    domainEndpointOptions: {
        enforceHttps: true,
        tlsSecurityPolicy: "Policy-Min-TLS-1-2-2019-07",
    },
    vpcOptions: {
        subnetIds: [vpc.privateSubnetIds[0]],
        securityGroupIds: [openSearchSecurityGroup.id],
    },
    advancedSecurityOptions: {
        enabled: true,
        internalUserDatabaseEnabled: false,
        masterUserOptions: {
            masterUserArn: ecsTaskRole.arn,
        },
    },
    accessPolicies: pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "AWS": "${ecsTaskRole.arn}"
                },
                "Action": "es:*",
                "Resource": "arn:aws:es:${aws.getRegionOutput().name}:${aws.getCallerIdentityOutput().accountId}:domain/${appName}-${environment}/*"
            }
        ]
    }`,
    tags: tags,
});

// Grant ECS task access to OpenSearch
const openSearchPolicy = new aws.iam.RolePolicy(`${appName}-opensearch-policy`, {
    role: ecsTaskRole.id,
    policy: openSearchDomain.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "es:ESHttpGet",
                "es:ESHttpPut",
                "es:ESHttpPost",
                "es:ESHttpDelete",
            ],
            Resource: `${arn}/*`,
        }],
    })),
});

// Grant ECS task access to AWS Bedrock for Claude models and Titan Embeddings
const bedrockPolicy = new aws.iam.RolePolicy(`${appName}-bedrock-policy`, {
    role: ecsTaskRole.id,
    policy: pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream"
                ],
                "Resource": [
                    "arn:aws:bedrock:*::foundation-model/*",
                    "arn:aws:bedrock:*:${aws.getCallerIdentityOutput().accountId}:inference-profile/*"
                ]
            },
            {
                "Effect": "Allow",
                "Action": [
                    "aws-marketplace:ViewSubscriptions",
                    "aws-marketplace:Subscribe"
                ],
                "Resource": "*"
            }
        ]
    }`,
});

// =============================================================================
// Application Load Balancer
// =============================================================================

const alb = new aws.lb.LoadBalancer(`${appName}-alb`, {
    loadBalancerType: "application",
    subnets: vpc.publicSubnetIds,
    securityGroups: [albSecurityGroup.id],
    tags: tags,
});

const targetGroup = new aws.lb.TargetGroup(`${appName}-tg`, {
    port: 3001,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: vpc.vpcId,
    healthCheck: {
        enabled: true,
        path: "/api/health",
        healthyThreshold: 2,
        unhealthyThreshold: 3,
        timeout: 5,
        interval: 30,
        matcher: "200",
    },
    tags: tags,
});

const listener = new aws.lb.Listener(`${appName}-listener`, {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
    }],
    tags: tags,
});

// =============================================================================
// ECS Cluster and Service
// =============================================================================

const cluster = new aws.ecs.Cluster(`${appName}-cluster`, {
    settings: [{
        name: "containerInsights",
        value: "enabled",
    }],
    tags: tags,
});

// CloudWatch Log Group for ECS tasks
const logGroup = new aws.cloudwatch.LogGroup(`${appName}-logs`, {
    retentionInDays: 7,
    tags: tags,
});

// ECS Task Definition
const taskDefinition = new aws.ecs.TaskDefinition(`${appName}-task`, {
    family: `${appName}-app`,
    cpu: "512",
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: ecsTaskRole.arn,
    containerDefinitions: pulumi.all([
        logGroup.name,
        openSearchDomain.endpoint,
        secretsManagerSecret.arn,
        image.ref,
        aws.getRegionOutput().name,
    ]).apply(([logGroupName, opensearchEndpoint, secretArn, imageDigest, awsRegion]) => JSON.stringify([{
        name: "app",
        image: imageDigest, // Use the built and pushed Docker image
        essential: true,
        portMappings: [{
            containerPort: 3001,
            protocol: "tcp",
        }],
        environment: [
            {name: "PORT", value: "3001"},
            {name: "NODE_ENV", value: nodeEnv},
            {name: "LOG_LEVEL", value: "debug"}, // Set to "debug" for verbose logging, "info" for production
            {name: "DEFAULT_LLM_PROVIDER", value: "bedrock"},
            {name: "BEDROCK_MODEL", value: "anthropic.claude-3-5-sonnet-20240620-v1:0"},
            {name: "OPENSEARCH_ENDPOINT", value: `https://${opensearchEndpoint}`},
            {name: "OPENSEARCH_INDEX", value: "otel_knowledge"},
            {name: "OPENSEARCH_USERNAME", value: "admin"},
            {name: "AWS_REGION", value: awsRegion},
            // Honeycomb Observability Configuration
            {name: "HONEYCOMB_DATASET", value: `${appName}-${environment}`},
            {name: "OTEL_SERVICE_NAME", value: `${appName}-backend`},
            {name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "https://api.honeycomb.io"},
            {name: "OTEL_EXPORTER_OTLP_PROTOCOL", value: "http/protobuf"},
            // Enable OpenTelemetry GenAI Semantic Conventions v1.0 (stable)
            {name: "OTEL_SEMCONV_STABILITY_OPT_IN", value: "gen_ai"},
        ],
        secrets: [
            {
                name: "OPENSEARCH_PASSWORD",
                valueFrom: `${secretArn}:OPENSEARCH_PASSWORD::`,
            },
            {
                name: "HONEYCOMB_API_KEY",
                valueFrom: `${secretArn}:HONEYCOMB_API_KEY::`,
            },
            {
                name: "OTEL_EXPORTER_OTLP_HEADERS",
                valueFrom: `${secretArn}:OTEL_EXPORTER_OTLP_HEADERS::`,
            },
        ],
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": logGroupName,
                "awslogs-region": awsRegion,
                "awslogs-stream-prefix": "app",
            },
        },
    }])),
    tags: tags,
});

// ECS Service
const service = new aws.ecs.Service(`${appName}-service`, {
    cluster: cluster.arn,
    taskDefinition: taskDefinition.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    networkConfiguration: {
        subnets: vpc.privateSubnetIds,
        securityGroups: [ecsSecurityGroup.id],
        assignPublicIp: false,
    },
    loadBalancers: [{
        targetGroupArn: targetGroup.arn,
        containerName: "app",
        containerPort: 3001,
    }],
    tags: tags,
}, {dependsOn: [listener]});

// =============================================================================
// CloudWatch Metric Streams to Honeycomb
// =============================================================================

// Create IAM role for Firehose to write to Honeycomb
const firehoseRole = new aws.iam.Role(`${appName}-firehose-role`, {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {Service: "firehose.amazonaws.com"},
            Action: "sts:AssumeRole",
        }],
    }),
    tags: tags,
});

// Create S3 bucket for failed delivery backup
const firehoseBackupBucket = new aws.s3.Bucket(`${appName}-firehose-backup`, {
    forceDestroy: true,
    tags: tags,
});

// Grant Firehose permissions to write to S3 backup bucket
const firehoseS3Policy = new aws.iam.RolePolicy(`${appName}-firehose-s3-policy`, {
    role: firehoseRole.id,
    policy: firehoseBackupBucket.arn.apply(bucketArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "s3:AbortMultipartUpload",
                "s3:GetBucketLocation",
                "s3:GetObject",
                "s3:ListBucket",
                "s3:ListBucketMultipartUploads",
                "s3:PutObject",
            ],
            Resource: [
                bucketArn,
                `${bucketArn}/*`,
            ],
        }],
    })),
});

// Create Kinesis Firehose delivery stream to Honeycomb
const firehoseDeliveryStream = new aws.kinesis.FirehoseDeliveryStream(`${appName}-metrics-stream`, {
    name: `${appName}-metrics-to-honeycomb`,
    destination: "http_endpoint",
    httpEndpointConfiguration: {
        url: pulumi.interpolate`https://api.honeycomb.io/1/kinesis_events/${appName}-${environment}`,
        name: "Honeycomb",
        accessKey: config.requireSecret("honeycombApiKey"),
        roleArn: firehoseRole.arn,
        s3BackupMode: "FailedDataOnly",
        s3Configuration: {
            roleArn: firehoseRole.arn,
            bucketArn: firehoseBackupBucket.arn,
            compressionFormat: "GZIP",
        },
        requestConfiguration: {
            contentEncoding: "GZIP",
        },
        bufferingInterval: 60,
        bufferingSize: 1,
    },
    tags: tags,
}, {dependsOn: [firehoseS3Policy]});

// Create IAM role for CloudWatch to write to Firehose
const metricStreamRole = new aws.iam.Role(`${appName}-metric-stream-role`, {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {Service: "streams.metrics.cloudwatch.amazonaws.com"},
            Action: "sts:AssumeRole",
        }],
    }),
    tags: tags,
});

// Grant CloudWatch Metric Stream permission to write to Firehose
const metricStreamPolicy = new aws.iam.RolePolicy(`${appName}-metric-stream-policy`, {
    role: metricStreamRole.id,
    policy: firehoseDeliveryStream.arn.apply(firehoseArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "firehose:PutRecord",
                "firehose:PutRecordBatch",
            ],
            Resource: firehoseArn,
        }],
    })),
});

// Create CloudWatch Metric Stream to send ECS metrics to Honeycomb
const metricStream = new aws.cloudwatch.MetricStream(`${appName}-metric-stream`, {
    name: `${appName}-ecs-metrics`,
    roleArn: metricStreamRole.arn,
    firehoseArn: firehoseDeliveryStream.arn,
    outputFormat: "opentelemetry1.0", // Use OpenTelemetry format for Honeycomb compatibility
    includeFilters: [
        {
            namespace: "AWS/ECS",
            metricNames: [],  // Empty array means include all metrics from this namespace
        },
        {
            namespace: "ECS/ContainerInsights",
            metricNames: [],
        },
    ],
    tags: tags,
}, {dependsOn: [metricStreamPolicy]});

// =============================================================================
// Outputs
// =============================================================================

// Container Registry
export const ecrRepositoryUrl = ecrRepository.repositoryUrl;
export const ecrRepositoryName = ecrRepository.name;
export const containerImageDigest = image.ref;



// Infrastructure
export const vpcId = vpc.vpcId;
export const albDnsName = alb.dnsName;
export const albUrl = pulumi.interpolate`http://${alb.dnsName}`; // ALB serves both frontend and backend
export const openSearchEndpoint = openSearchDomain.endpoint;
export const openSearchDashboard = openSearchDomain.dashboardEndpoint;
export const ecsClusterName = cluster.name;
export const secretsManagerSecretArn = secretsManagerSecret.arn;

// Useful commands (optional - automated builds handle Docker)
export const ecrLoginCommand = pulumi.interpolate`aws ecr get-login-password --region ${aws.getRegionOutput().name} | docker login --username AWS --password-stdin ${ecrRepository.repositoryUrl}`;
export const dockerBuildCommand = pulumi.interpolate`docker build -t ${ecrRepository.repositoryUrl}:latest ../ && docker push ${ecrRepository.repositoryUrl}:latest`;

// Observability
export const metricStreamName = metricStream.name;
export const firehoseStreamName = firehoseDeliveryStream.name;
