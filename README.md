# WarmReach

<p align="center">
<a href="https://www.apache.org/licenses/LICENSE-2.0.html"><img src="https://img.shields.io/badge/license-Apache2.0-blue" alt="Apache 2.0 License" /></a>
<a href="https://www.python.org/"><img src="https://img.shields.io/badge/Python-3.13-3776AB" alt="Python 3.13" /></a>
<a href="https://react.dev"><img src="https://img.shields.io/badge/React-18-61DAFB" alt="React 18" /></a>
<a href="https://aws.amazon.com/lambda/"><img src="https://img.shields.io/badge/AWS-Lambda-FF9900" alt="AWS Lambda" /></a>
</p>

LinkedIn networking tool that helps build authentic professional relationships through active connection analysis, engagement surfacing, and AI-assisted outreach. Built for efficiency, security, and scalability.

** THIS REPO IS IN ACTIVE DEVELOPMENT AND WILL CHANGE OFTEN **

## 📚 Documentation

-   **[Architecture](docs/ARCHITECTURE.md)**: System design and components.
-   **[Development Guide](docs/DEVELOPMENT.md)**: Setup, running, and testing instructions.
-   **[Configuration](docs/CONFIGURATION.md)**: Environment variables and settings.
-   **[Deployment](docs/DEPLOYMENT.md)**: How to deploy to AWS using SAM.
-   **[Security](docs/SECURITY.md)**: Authentication and credential management.
-   **[API Reference](docs/API_REFERENCE.md)**: Overview of available API endpoints.
-   **[Troubleshooting](docs/TROUBLESHOOTING.md)**: Solutions for common issues.

## ✨ Features

-   **LinkedIn Automation**: Queue-based interaction system with session preservation.
-   **RAGStack Integration**: Semantic search and text ingestion using AWS Bedrock and RAGStack-Lambda.
-   **Content Generation**: OpenAI integration for personalized messaging and post creation.
-   **Credential Management**: Sealbox encryption with device-specific key management.
-   **Heal & Restore**: Checkpoint-based recovery for long-running automation processes.
-   **Cloud Native**: Fully serverless backend using AWS Lambda, DynamoDB, and S3.

## 🚀 Quick Start

### Option A: Docker (Recommended)

```bash
git clone <your-repo-url>
cd warmreach
bash scripts/setup.sh
docker compose up
```

Frontend at http://localhost:5173, client backend at http://localhost:3001, mock LinkedIn at http://localhost:3333.

### Option B: Manual Setup

**Prerequisites:** Node.js 24 LTS, Python 3.13, Chrome/Chromium

```bash
bash scripts/setup.sh       # Install all dependencies + create .env
npm run dev                  # Frontend: http://localhost:5173
npm run dev:client           # Backend: http://localhost:3001
```

See [Development Guide](docs/DEVELOPMENT.md) for detailed instructions.

## 🛠️ Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS |
| **Client (Automation)** | Electron, Node.js, Express, Puppeteer |
| **Cloud (AWS)** | Lambda, DynamoDB, API Gateway, Cognito, S3 |
| **AI** | OpenAI GPT models |

## 📜 License

Apache 2.0 - see [LICENSE](LICENSE)
