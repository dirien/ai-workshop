# Pulumi Infrastructure for OpenTelemetry AI Chatbot

This directory contains the Pulumi infrastructure code to deploy the OpenTelemetry AI Chatbot to AWS using:

- **Amazon OpenSearch Service** - Vector database with k-NN search
- **Amazon ECS Fargate** - Containerized application (backend + frontend)
- **Application Load Balancer** - HTTP(S) load balancing for both frontend and API
- **Amazon ECR** - Container registry with automated builds
- **AWS Secrets Manager** - Secure API key storage
- **Amazon VPC** - Network isolation

## Architecture

**Simplified**: The container serves both React frontend and backend API. No separate S3/CloudFront!

```
Internet → ALB → ECS Fargate Container → OpenSearch (Vector DB)
                 (Backend API + React App) → LLM APIs (OpenAI/Anthropic/Bedrock)
```

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **Pulumi CLI** installed ([installation guide](https://www.pulumi.com/docs/install/))
3. **Node.js 18+** installed
4. **AWS CLI** configured with credentials
5. **Docker** (for building container images)

## Setup

### 1. Install Dependencies

```bash
cd pulumi
pulumi install
```

### 2. Configure Pulumi

```bash
# Login to Pulumi (use local backend or Pulumi Cloud)
pulumi login

# Create a new stack (e.g., dev, staging, prod)
pulumi stack init dev

# Configure required secrets
pulumi config set --secret opensearchMasterPassword <strong-password>

# Optional: Configure API keys (or set them manually in Secrets Manager later)
pulumi config set --secret openaiApiKey <your-openai-key>
pulumi config set --secret anthropicApiKey <your-anthropic-key>
```

### 3. Deploy Infrastructure (Automated Build)

**✨ New Feature**: Container builds are now fully automated! Just run `pulumi up` and Pulumi will:
- Create ECR repository
- Build Docker image from your code
- Push image to ECR
- Deploy to ECS Fargate

No manual Docker commands required!

```bash
# Ensure Docker is running
docker ps

# Deploy everything (builds and deploys automatically)
pulumi up
```

**First deployment takes ~15-20 minutes** (includes Docker build ~2-5 min + infrastructure creation ~10-15 min)

See [`AUTOMATED_BUILD.md`](../.memory/AUTOMATED_BUILD.md) for details on the automated build process.

#### Manual Build (Optional)

If you prefer manual control, you can still build and push manually:

```bash
# Use Pulumi outputs for automated commands
pulumi stack output ecrLoginCommand | bash
pulumi stack output dockerBuildCommand | bash
```

### 4. Verify Deployment

Check that the application is running:

```bash
# Get ALB URL (serves both frontend and backend)
ALB_URL=$(pulumi stack output albUrl)

# Test backend health
curl $ALB_URL/api/health

# Open frontend in browser
open $ALB_URL
```

**Note**: The container serves both the React frontend (on `/`) and the backend API (on `/api/*`).

### 5. Ingest Documentation

SSH into your ECS task or run the ingest script locally pointing to OpenSearch:

```bash
# Get OpenSearch endpoint
OPENSEARCH_ENDPOINT=$(pulumi stack output openSearchEndpoint)

# Update ingest script to use OpenSearch
# Then run data ingestion
cd ..
node scripts/ingest-data.js
```

## Configuration Options

### Stack Configuration

```bash
# Set OpenSearch master user (default: admin)
pulumi config set opensearchMasterUser admin

# Set OpenSearch master password (required)
pulumi config set --secret opensearchMasterPassword <password>

# Set API keys (optional - can be set in Secrets Manager later)
pulumi config set --secret openaiApiKey <key>
pulumi config set --secret anthropicApiKey <key>
```

**Note**: The `backendImage` config is no longer needed - Pulumi builds and pushes automatically!

## Cost Optimization

The default configuration uses cost-optimized resources:

- **OpenSearch**: t3.small.search instance (single node, 10GB storage)
- **ECS Fargate**: 0.5 vCPU, 1GB memory
- **NAT Gateway**: Single NAT gateway (can be removed for further savings)

### Estimated Monthly Cost

- OpenSearch: ~$40/month
- ECS Fargate: ~$15/month (with low traffic)
- NAT Gateway: ~$32/month
- ALB: ~$16/month
- ECR: ~$0.30/month (10 images stored)
- **Total**: ~$100-105/month

### Further Cost Reduction

To reduce costs for development:

```typescript
// In index.ts, modify:

// Use smaller OpenSearch instance
instanceType: "t3.small.search",  // Already optimized

// Remove NAT Gateway (ECS tasks must have public IP)
natGateways: {
    strategy: "None",  // Requires assignPublicIp: true in ECS
}

// Reduce ECS resources
cpu: "256",
memory: "512",
```

## Useful Commands

```bash
# View stack outputs
pulumi stack output

# View specific output
pulumi stack output albUrl

# Update infrastructure
pulumi up

# Destroy infrastructure
pulumi destroy

# View stack state
pulumi stack

# Export stack for backup
pulumi stack export > stack-backup.json
```

## Accessing OpenSearch Dashboard

```bash
# Get dashboard URL
pulumi stack output openSearchDashboard

# Create SSH tunnel through ECS task (OpenSearch is in private subnet)
# Or configure VPN/bastion host access
```

## Troubleshooting

### ECS Task Fails to Start

1. Check CloudWatch logs:
   ```bash
   aws logs tail /aws/ecs/otel-ai-chatbot-logs --follow
   ```

2. Verify secrets in Secrets Manager are populated

3. Check ECS task IAM permissions

### Bedrock Model Access Denied

If you see an error like:
```
Model access is denied due to IAM user or service role is not authorized to perform
the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)
```

The ECS task role needs AWS Marketplace permissions to access Claude models through Bedrock. The infrastructure code includes these permissions. If you recently updated the IAM policy, wait 5 minutes for changes to propagate, or force a new ECS deployment:

```bash
aws ecs update-service --cluster <cluster-name> --service <service-name> --force-new-deployment
```

### OpenSearch Service Linked Role Already Exists

If you see an error like:
```
Service role name AWSServiceRoleForAmazonElasticsearchService has been taken in this account
```

This means the OpenSearch Service Linked Role already exists in your AWS account. Import it into Pulumi state:

```bash
pulumi import aws:iam/serviceLinkedRole:ServiceLinkedRole opensearch-service-linked-role \
  arn:aws:iam::<account-id>:role/aws-service-role/es.amazonaws.com/AWSServiceRoleForAmazonElasticsearchService
```

Replace `<account-id>` with your AWS account ID.

### OpenSearch Connection Issues

1. Verify security group allows traffic from ECS
2. Check OpenSearch access policies
3. Verify OpenSearch domain is active (can take 10-15 minutes to create)

### Frontend Not Loading

1. Verify ECS container is running with NODE_ENV=production
2. Check container logs: `aws logs tail /aws/ecs/otel-ai-chatbot-logs --follow`
3. Verify ALB target group health status
4. Test if frontend is built in container: `docker run --rm ai-chatbot ls -la /app/client/build/`

## Monitoring

The infrastructure includes:

- **CloudWatch Container Insights** - ECS cluster monitoring
- **CloudWatch Logs** - Application logs with 7-day retention
- **ALB Access Logs** - Can be enabled for debugging

## Security Considerations

1. **OpenSearch** - Uses VPC deployment, encryption at rest, node-to-node encryption, and fine-grained access control
2. **Secrets** - API keys stored in AWS Secrets Manager
3. **Network** - Private subnets for ECS and OpenSearch, public subnets only for ALB
4. **HTTPS** - ALB can be configured with ACM certificate for HTTPS
5. **Container** - Runs as non-root user (nodejs:1001), minimal Alpine base

## Updating the Application

### Application Updates (Backend + Frontend)

**Automated** (recommended):
```bash
# Make your code changes (backend or frontend)
cd pulumi
pulumi up
```

Pulumi will automatically:
1. Detect code changes
2. Rebuild Docker image (with layer caching)
3. Push to ECR
4. Update ECS service
5. Wait for deployment to complete

**Manual** (if needed):
```bash
# Use Pulumi output commands
pulumi stack output ecrLoginCommand | bash
pulumi stack output dockerBuildCommand | bash

# Force ECS service to deploy new version
aws ecs update-service \
  --cluster $(pulumi stack output ecsClusterName) \
  --service otel-ai-chatbot-service \
  --force-new-deployment
```

## Additional Documentation

Comprehensive guides are available in the `docs/` folder:

- **[AUTOMATED_BUILD.md](../.memory/AUTOMATED_BUILD.md)** - Complete guide to automated Docker builds with Pulumi
- **[AWS_DEPLOYMENT.md](../.memory/AWS_DEPLOYMENT.md)** - Step-by-step AWS deployment guide
- **[DEPLOYMENT_SUMMARY.md](../.memory/DEPLOYMENT_SUMMARY.md)** - Quick reference for deployment commands and outputs
- **[ECR_DOCKER_INTEGRATION.md](../.memory/ECR_DOCKER_INTEGRATION.md)** - Detailed ECR and Docker integration documentation
- **[OPENSEARCH_MIGRATION.md](../.memory/OPENSEARCH_MIGRATION.md)** - Guide for migrating from ChromaDB to OpenSearch
- **[DOCKER_BUILD_CLOUD.md](../.memory/DOCKER_BUILD_CLOUD.md)** - Docker Build Cloud integration guide
- **[DOCKER_BUILD_CLOUD_ISSUE.md](../.memory/DOCKER_BUILD_CLOUD_ISSUE.md)** - Troubleshooting Docker Build Cloud issues
- **[QUICKSTART_DOCKER_BUILD_CLOUD.md](../.memory/QUICKSTART_DOCKER_BUILD_CLOUD.md)** - Quick start for Docker Build Cloud
- **[WHATS_NEW.md](../.memory/WHATS_NEW.md)** - Recent changes and new features
- **[API.md](../.memory/API.md)** - API documentation
- **[SETUP.md](../.memory/SETUP.md)** - General setup documentation

## Next Steps

1. **Add Custom Domain** - Configure Route 53 and ACM certificate
2. **Enable HTTPS on ALB** - Add ACM certificate to ALB listener
3. **Add Auto-scaling** - Configure ECS service auto-scaling based on CPU/memory
4. **Add Monitoring** - Set up CloudWatch dashboards and alarms
5. **Add CI/CD** - Integrate with GitHub Actions or AWS CodePipeline
6. **Add WAF** - Attach AWS WAF to ALB for security
7. **Add CDN** - Optional: Add CloudFront in front of ALB for global edge caching
