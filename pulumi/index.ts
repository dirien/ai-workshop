import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as docker from "@pulumi/docker";
import { CacheInfrastructure } from "./cache-infrastructure";

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
const image = new docker.Image(`${appName}-image`, {
    imageName: pulumi.interpolate`${ecrRepository.repositoryUrl}:${environment}`,
    build: {
        context: "../", // Build from the parent directory (project root)
        dockerfile: "../Dockerfile",
        platform: "linux/amd64", // Build for x86_64 architecture
        args: {
            NODE_ENV: "production",
        },
    },
    //skipPush: true,
    registry: {
        server: ecrRepository.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
    },
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
// ElastiCache Redis for Multi-Layer Caching
// =============================================================================

const cacheInfra = new CacheInfrastructure(`${appName}-cache-infra`, {
    appName,
    environment,
    vpcId: vpc.vpcId,
    privateSubnetIds: vpc.privateSubnetIds,
    ecsSecurityGroupId: ecsSecurityGroup.id,
    tags,
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
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: ecsTaskRole.arn,
    containerDefinitions: pulumi.all([
        logGroup.name,
        openSearchDomain.endpoint,
        secretsManagerSecret.arn,
        image.repoDigest,
        aws.getRegionOutput().name,
        cacheInfra.primaryEndpoint,
    ]).apply(([logGroupName, opensearchEndpoint, secretArn, imageDigest, awsRegion, redisEndpoint]) => JSON.stringify([{
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
            // Redis Cache Configuration
            {name: "REDIS_HOST", value: redisEndpoint},
            {name: "REDIS_PORT", value: "6379"},
            {name: "REDIS_ENABLED", value: "true"},
            {name: "CACHE_TTL_RESPONSE", value: "86400"}, // 24 hours for full responses
            {name: "CACHE_TTL_VECTOR", value: "43200"}, // 12 hours for vector search results
            {name: "CACHE_TTL_EMBEDDING", value: "604800"}, // 7 days for embeddings
            // Honeycomb Observability Configuration
            {name: "HONEYCOMB_DATASET", value: `${appName}-${environment}`},
            {name: "OTEL_SERVICE_NAME", value: `${appName}-backend`},
            {name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "https://api.honeycomb.io"},
            {name: "OTEL_EXPORTER_OTLP_PROTOCOL", value: "http/protobuf"},
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
// Outputs
// =============================================================================

// Container Registry
export const ecrRepositoryUrl = ecrRepository.repositoryUrl;
export const ecrRepositoryName = ecrRepository.name;
export const containerImageDigest = image.repoDigest;



// Infrastructure
export const vpcId = vpc.vpcId;
export const albDnsName = alb.dnsName;
export const albUrl = pulumi.interpolate`http://${alb.dnsName}`; // ALB serves both frontend and backend
export const openSearchEndpoint = openSearchDomain.endpoint;
export const openSearchDashboard = openSearchDomain.dashboardEndpoint;
export const ecsClusterName = cluster.name;
export const secretsManagerSecretArn = secretsManagerSecret.arn;

// Cache Infrastructure
export const redisPrimaryEndpoint = cacheInfra.primaryEndpoint;
export const redisReaderEndpoint = cacheInfra.readerEndpoint;
export const redisPort = cacheInfra.port;

// Useful commands (optional - automated builds handle Docker)
export const ecrLoginCommand = pulumi.interpolate`aws ecr get-login-password --region ${aws.getRegionOutput().name} | docker login --username AWS --password-stdin ${ecrRepository.repositoryUrl}`;
export const dockerBuildCommand = pulumi.interpolate`docker build -t ${ecrRepository.repositoryUrl}:latest ../ && docker push ${ecrRepository.repositoryUrl}:latest`;

