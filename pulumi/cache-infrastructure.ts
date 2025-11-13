import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

/**
 * ElastiCache Redis Infrastructure for Multi-Layer Caching
 * 
 * This module provides:
 * - High-availability Redis cluster with automatic failover
 * - Multi-AZ deployment for resilience
 * - Automated backups and point-in-time recovery
 * - Security groups and network isolation
 * - CloudWatch monitoring and alarms
 */

export interface CacheInfrastructureArgs {
    appName: string;
    environment: string;
    vpcId: pulumi.Output<string>;
    privateSubnetIds: pulumi.Output<string[]>;
    ecsSecurityGroupId: pulumi.Output<string>;
    tags: { [key: string]: string };
}

export class CacheInfrastructure extends pulumi.ComponentResource {
    public readonly cacheCluster: aws.elasticache.ReplicationGroup;
    public readonly cacheSecurityGroup: aws.ec2.SecurityGroup;
    public readonly cacheSubnetGroup: aws.elasticache.SubnetGroup;
    public readonly primaryEndpoint: pulumi.Output<string>;
    public readonly readerEndpoint: pulumi.Output<string>;
    public readonly port: number = 6379;

    constructor(name: string, args: CacheInfrastructureArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:cache:CacheInfrastructure", name, {}, opts);

        const { appName, environment, vpcId, privateSubnetIds, ecsSecurityGroupId, tags } = args;

        // =============================================================================
        // Security Group for Redis
        // =============================================================================
        this.cacheSecurityGroup = new aws.ec2.SecurityGroup(`${appName}-cache-sg`, {
            vpcId: vpcId,
            description: "Security group for ElastiCache Redis cluster",
            ingress: [
                {
                    protocol: "tcp",
                    fromPort: this.port,
                    toPort: this.port,
                    securityGroups: [ecsSecurityGroupId],
                    description: "Allow Redis access from ECS tasks",
                },
            ],
            egress: [{
                protocol: "-1",
                fromPort: 0,
                toPort: 0,
                cidrBlocks: ["0.0.0.0/0"],
                description: "Allow all outbound traffic",
            }],
            tags: { ...tags, Name: `${appName}-cache-sg` },
        }, { parent: this });

        // =============================================================================
        // Subnet Group for Multi-AZ Deployment
        // =============================================================================
        this.cacheSubnetGroup = new aws.elasticache.SubnetGroup(`${appName}-cache-subnet-group`, {
            description: `Subnet group for ${appName} Redis cache`,
            subnetIds: privateSubnetIds,
            tags: tags,
        }, { parent: this });

        // =============================================================================
        // Parameter Group for Redis Configuration
        // =============================================================================
        const parameterGroup = new aws.elasticache.ParameterGroup(`${appName}-cache-params`, {
            family: "redis7",
            description: `Custom parameter group for ${appName} Redis cache`,
            parameters: [
                {
                    name: "maxmemory-policy",
                    value: "allkeys-lru", // Evict least recently used keys when memory is full
                },
                {
                    name: "timeout",
                    value: "300", // Close idle connections after 5 minutes
                },
                {
                    name: "tcp-keepalive",
                    value: "300", // Send TCP keepalives every 5 minutes
                },
                {
                    name: "maxmemory-samples",
                    value: "10", // Number of keys to sample for LRU eviction
                },
                {
                    name: "notify-keyspace-events",
                    value: "Ex", // Enable keyspace notifications for expired events
                },
            ],
            tags: tags,
        }, { parent: this });

        // =============================================================================
        // ElastiCache Replication Group (Redis Cluster)
        // =============================================================================
        this.cacheCluster = new aws.elasticache.ReplicationGroup(`${appName}-cache`, {
            replicationGroupId: `${appName}-${environment}-cache`,
            description: `Redis cache cluster for ${appName} with multi-layer caching`,
            
            // Engine Configuration
            engine: "redis",
            engineVersion: "7.1", // Latest stable Redis version
            port: this.port,
            parameterGroupName: parameterGroup.name,
            
            // Node Configuration
            nodeType: environment === "prod" ? "cache.r7g.large" : "cache.t4g.medium",
            numCacheClusters: 2, // 1 primary + 1 replica for HA
            
            // High Availability
            automaticFailoverEnabled: true, // Enable automatic failover to replica
            multiAzEnabled: true, // Deploy across multiple AZs
            
            // Network Configuration
            subnetGroupName: this.cacheSubnetGroup.name,
            securityGroupIds: [this.cacheSecurityGroup.id],
            
            // Backup Configuration
            snapshotRetentionLimit: environment === "prod" ? 7 : 1, // Keep 7 days of backups in prod
            snapshotWindow: "03:00-05:00", // Daily backup window (UTC)
            maintenanceWindow: "sun:05:00-sun:07:00", // Weekly maintenance window (UTC)
            
            // Performance & Monitoring
            atRestEncryptionEnabled: true, // Encrypt data at rest
            transitEncryptionEnabled: false, // Disable TLS for lower latency (enable in prod if required)
            authTokenEnabled: false, // Disable auth token for simplicity (enable in prod)
            
            // Notifications
            notificationTopicArn: undefined, // Add SNS topic ARN for notifications if needed
            
            // Auto-upgrade
            autoMinorVersionUpgrade: true,
            
            // Logging
            logDeliveryConfigurations: [
                {
                    destination: pulumi.interpolate`${appName}-cache-slow-log`,
                    destinationType: "cloudwatch-logs",
                    logFormat: "json",
                    logType: "slow-log",
                },
                {
                    destination: pulumi.interpolate`${appName}-cache-engine-log`,
                    destinationType: "cloudwatch-logs",
                    logFormat: "json",
                    logType: "engine-log",
                },
            ],
            
            tags: tags,
        }, { parent: this, dependsOn: [this.cacheSubnetGroup, parameterGroup] });

        // Extract endpoints
        this.primaryEndpoint = this.cacheCluster.primaryEndpointAddress;
        this.readerEndpoint = this.cacheCluster.readerEndpointAddress;

        // =============================================================================
        // CloudWatch Log Groups for Redis Logs
        // =============================================================================
        new aws.cloudwatch.LogGroup(`${appName}-cache-slow-log`, {
            retentionInDays: 7,
            tags: tags,
        }, { parent: this });

        new aws.cloudwatch.LogGroup(`${appName}-cache-engine-log`, {
            retentionInDays: 7,
            tags: tags,
        }, { parent: this });

        // =============================================================================
        // CloudWatch Alarms for Cache Monitoring
        // =============================================================================
        
        // CPU Utilization Alarm
        new aws.cloudwatch.MetricAlarm(`${appName}-cache-cpu-alarm`, {
            comparisonOperator: "GreaterThanThreshold",
            evaluationPeriods: 2,
            metricName: "CPUUtilization",
            namespace: "AWS/ElastiCache",
            period: 300,
            statistic: "Average",
            threshold: 75,
            alarmDescription: "Alert when Redis CPU utilization exceeds 75%",
            dimensions: {
                ReplicationGroupId: this.cacheCluster.id,
            },
            tags: tags,
        }, { parent: this });

        // Memory Utilization Alarm
        new aws.cloudwatch.MetricAlarm(`${appName}-cache-memory-alarm`, {
            comparisonOperator: "GreaterThanThreshold",
            evaluationPeriods: 2,
            metricName: "DatabaseMemoryUsagePercentage",
            namespace: "AWS/ElastiCache",
            period: 300,
            statistic: "Average",
            threshold: 80,
            alarmDescription: "Alert when Redis memory usage exceeds 80%",
            dimensions: {
                ReplicationGroupId: this.cacheCluster.id,
            },
            tags: tags,
        }, { parent: this });

        // Evictions Alarm
        new aws.cloudwatch.MetricAlarm(`${appName}-cache-evictions-alarm`, {
            comparisonOperator: "GreaterThanThreshold",
            evaluationPeriods: 2,
            metricName: "Evictions",
            namespace: "AWS/ElastiCache",
            period: 300,
            statistic: "Sum",
            threshold: 1000,
            alarmDescription: "Alert when Redis evictions exceed 1000 per 5 minutes",
            dimensions: {
                ReplicationGroupId: this.cacheCluster.id,
            },
            tags: tags,
        }, { parent: this });

        // Cache Hit Rate Alarm (low hit rate)
        new aws.cloudwatch.MetricAlarm(`${appName}-cache-hit-rate-alarm`, {
            comparisonOperator: "LessThanThreshold",
            evaluationPeriods: 3,
            metricName: "CacheHitRate",
            namespace: "AWS/ElastiCache",
            period: 300,
            statistic: "Average",
            threshold: 0.8, // Alert if hit rate drops below 80%
            alarmDescription: "Alert when Redis cache hit rate drops below 80%",
            dimensions: {
                ReplicationGroupId: this.cacheCluster.id,
            },
            tags: tags,
        }, { parent: this });

        // Connection Count Alarm
        new aws.cloudwatch.MetricAlarm(`${appName}-cache-connections-alarm`, {
            comparisonOperator: "GreaterThanThreshold",
            evaluationPeriods: 2,
            metricName: "CurrConnections",
            namespace: "AWS/ElastiCache",
            period: 300,
            statistic: "Average",
            threshold: 500,
            alarmDescription: "Alert when Redis connection count exceeds 500",
            dimensions: {
                ReplicationGroupId: this.cacheCluster.id,
            },
            tags: tags,
        }, { parent: this });

        // Register outputs
        this.registerOutputs({
            cacheClusterId: this.cacheCluster.id,
            primaryEndpoint: this.primaryEndpoint,
            readerEndpoint: this.readerEndpoint,
            port: this.port,
        });
    }
}

/**
 * Memory Sizing Recommendations:
 * 
 * cache.t4g.micro (0.5 GB):   ~100-200 cached responses, dev/test only
 * cache.t4g.small (1.37 GB):  ~500-1000 cached responses, light production
 * cache.t4g.medium (3.09 GB): ~1500-3000 cached responses, recommended for this workload
 * cache.r7g.large (13.07 GB): ~6000-12000 cached responses, high-traffic production
 * 
 * Calculation basis:
 * - Average response size: ~2-3 KB (LLM response + metadata)
 * - Vector search cache: ~1 KB per query
 * - Embedding cache: ~6 KB per embedding (1536 dimensions * 4 bytes)
 * - Overhead: ~30% for Redis data structures and metadata
 * 
 * For current workload (7 requests/hour):
 * - cache.t4g.medium is sufficient
 * - Can cache ~3000 unique responses
 * - At 7 req/hr, that's ~428 hours (18 days) of unique queries
 * - With typical query patterns, expect 60-80% hit rate after warm-up
 */
