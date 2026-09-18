# tidb-knowbase-indexer

Automated incremental knowledge base indexer with flexible embedding providers (SiliconFlow, Hugging Face, Gemini, OpenAI, Jina, and TiDB Cloud native Auto Embedding) and vector storage.

## Overview

`tidb-knowbase-indexer` synchronizes documents periodically via GitHub Actions (or locally) from multiple sources directly into TiDB Cloud:
- **Flexible Embedding Providers**:
  - **PingCAP Cloud China (`console.cloud.pingkai.cn`)**: Seamlessly connects to SiliconFlow (硅基流动 `https://api.siliconflow.cn/v1`) with completely free `BAAI/bge-m3` (1024-dim) or `BAAI/bge-large-zh-v1.5`, Hugging Face Inference API, Google Gemini, or Jina AI.
  - **TiDB Cloud Global (`tidbcloud.com` on AWS)**: Supports zero-key serverless `EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", text)` via `EMBEDDING_PROVIDER=tidb_auto`, as well as client-side embedding providers.
  - **Self-Healing Schema Migration**: Automatically detects if the table uses an Auto Embedding generated column or client-side `VECTOR(dim)` column and re-provisions cleanly if switching modes.
- **Private & Public Git Repositories**: Incremental indexing based on Git commit diffs (`git diff <lastCommit> HEAD`). Automatically supports token-based authentication for private repositories without needing SSH keys.
- **Websites & Blogs**: Recursively crawls web pages and extracts clean content.
- **Privacy Filter (`#confidential`)**: Automatically skips Markdown notes tagged with `#confidential` (in YAML frontmatter or inline body text), preventing sensitive notes from being indexed.
- **Enforced TLS Security**: Enforces TLS 1.2+ with certificate validation for all connections to TiDB Cloud Serverless.
- **Zero-Cost Architecture**: Runs on GitHub Actions free tier and uses TiDB Cloud Starter (free 5 GiB storage and 50M Request Units/month).
- **Log Sanitization**: Uses GitHub Actions secret masking (`@actions/core.setSecret`) to prevent leakage of database credentials, private URLs, and tokens into execution logs.
## Architecture

```
[ Git / Web Sources ]
        │
        ▼
 [ Chunking & Hashing ] ──(Commit Diff & #confidential filter)──┐
        │                                                        │
        ▼                                                        ▼
 [ Batch Text Insert ]                                 [ Calculate Diff ]
 (Plain text chunks)                                             │
        │                                                        │
        └───────────────────────────┬────────────────────────────┘
                                    │ (TLS 1.2+ Enforced)
                                    ▼
                         [ TiDB Cloud Starter ]
                  - chunks: text + EMBED_TEXT() -> VECTOR(1024)
                  - sync_state: incremental hash tracking
```

## Free Tier Setup

### Scenario A: PingCAP Cloud China (`console.cloud.pingkai.cn`)

PingCAP Cloud China clusters do not support `tidbcloud_free` (Bedrock). You can achieve 100% free vector indexing using **SiliconFlow (硅基流动)**:

1. Register at [SiliconFlow](https://siliconflow.cn/) and get a free API Key.
2. Set GitHub Secrets / Variables:
   - `EMBEDDING_PROVIDER`: `openai` (or leave default)
   - `EMBEDDING_BASE_URL`: `https://api.siliconflow.cn/v1`
   - `EMBEDDING_MODEL`: `BAAI/bge-m3`
   - `EMBEDDING_DIMENSION`: `1024`
   - `EMBEDDING_API_KEY`: Your SiliconFlow API Key (`sk-...`)

### Scenario B: TiDB Cloud Global (`tidbcloud.com` on AWS)

Global AWS clusters support built-in zero-configuration Auto Embedding:
1. Set `EMBEDDING_PROVIDER`: `tidb_auto`
2. No embedding API key is required!

### Scenario C: Hugging Face / Gemini / Jina
- **Hugging Face**: Set `HF_TOKEN` and optional `EMBEDDING_MODEL` (e.g. `BAAI/bge-m3`).
- **Google Gemini**: Set `GEMINI_API_KEY` (defaults to `text-embedding-004`, 768 dim).
- **Jina AI**: Set `JINA_API_KEY` (defaults to `jina-embeddings-v3`, 1024 dim).
---

## GitHub Actions Workflows & Parameters

In your GitHub repository, navigate to **Settings -> Secrets and variables -> Actions** to configure the following secrets and variables:

### 1. Repository Secrets (Sensitive Credentials)

Configure these in the **Secrets** tab:

| Secret Name | Required | Description | Example |
|---|:---:|---|---|
| `CONFIG_JSON` | **Yes** | JSON array configuring data sources (Git repositories or Web URLs). | `[{"name":"notes","type":"git","url":"..."}]` |
| `TIDB_DATABASE_URL` | **Yes** | Connection string for TiDB Cloud Starter. TLS 1.2+ is enforced automatically. | `mysql://<user>:<password>@gateway.tidbcloud.com:4000/test?ssl={"minVersion":"TLSv1.2"}` |
| `EMBEDDING_API_KEY` | Optional | API key for embedding provider (e.g. SiliconFlow, OpenAI). | `sk-...` |
| `HF_TOKEN` | Optional | Hugging Face User Access Token. | `hf_...` |
| `GEMINI_API_KEY` | Optional | Google Gemini API Key. | `AIza...` |
| `JINA_API_KEY` | Optional | Jina AI API Key. | `jina_...` |
| `GH_PAT` | Optional | GitHub Personal Access Token with repository read permissions for private Git sources. | `ghp_...` |
| `TIDB_HOST` | Optional | TiDB host address (alternative if `TIDB_DATABASE_URL` is omitted). | `gateway01.us-east-1.prod.aws.tidbcloud.com` |
| `TIDB_PORT` | Optional | TiDB port (defaults to `4000`). | `4000` |
| `TIDB_USER` | Optional | TiDB username (alternative if `TIDB_DATABASE_URL` is omitted). | `xxxxxx.root` |
| `TIDB_PASSWORD` | Optional | TiDB password (alternative if `TIDB_DATABASE_URL` is omitted). | `password` |
| `TIDB_DATABASE` | Optional | TiDB database name (defaults to `test`). | `test` |
### 2. Repository Variables (Non-Sensitive Configuration)

Configure these in the **Variables** tab (optional):

| Variable Name | Required | Default | Description |
|---|:---:|:---:|---|
| `EMBEDDING_PROVIDER` | No | `openai` | Embedding provider: `openai`, `siliconflow`, `huggingface`, `gemini`, `jina`, `tidb_auto`, `mock`. |
| `EMBEDDING_BASE_URL` | No | `https://api.siliconflow.cn/v1` | Base URL for OpenAI-compatible embedding API. |
| `EMBEDDING_MODEL` | No | `BAAI/bge-m3` | Embedding model identifier. |
| `EMBEDDING_DIMENSION` | No | `1024` | Vector dimension size. |
| `TIDB_SSL` | No | `true` | Enforces TLS connection to TiDB Cloud. |
| `TIDB_SSL_REJECT_UNAUTHORIZED` | No | `true` | Validates server CA certificate against trusted root CAs. |
| `TIDB_CA` | No | None | Custom CA certificate string or file path if needed. |
### 3. Workflow Manual Inputs (`workflow_dispatch`)

#### `sync.yml` (Knowledge Base Synchronization)
- **Schedule**: Runs automatically every day at 02:00 UTC (`0 2 * * *`) and on push to `main`.
- **Manual Trigger Inputs**:
  | Input Name | Type | Required | Default | Description |
  |---|:---:|:---:|:---:|---|
  | `force_clean` | `boolean` | No | `false` | Indicator for triggering a clean synchronization scan. |

#### `clear.yml` (Clear Knowledge Base Data)
- **Manual Trigger Inputs**:
  | Input Name | Type | Required | Default | Description |
  |---|:---:|:---:|:---:|---|
  | `source` | `string` | No | `""` (empty) | Exact source name to clear. Leave empty to clear ALL indexed chunks and sync states. |

#### `test.yml` (CI Automated Testing)
- **Triggers**: Runs on push and pull requests to `main`. Executes unit tests (`pnpm test`) and compilation (`pnpm build`). No extra secrets required.

---

## `CONFIG_JSON` Specification & Examples

`CONFIG_JSON` accepts an array of source objects supporting both Git repositories and Web websites:

```json
[
  {
    "name": "personal-notes",
    "type": "git",
    "url": "https://github.com/username/my-notes.git",
    "branch": "main",
    "include": ["**/*.md", "**/*.txt"],
    "exclude": [".trash/**", "templates/**"]
  },
  {
    "name": "tech-blog",
    "type": "web",
    "url": "https://example.com/blog",
    "maxDepth": 2,
    "urlPattern": "https://example.com/blog/.*"
  }
]
```

### Git Source Fields
- `name` (string, required): Unique identifier for the source.
- `type` (`"git"`, required): Source type.
- `url` (string, required): Git repository URL (HTTPS or SSH format).
- `branch` (string, optional, default: `"main"`): Branch to clone and diff against.
- `include` (string[], optional, default: `["**/*.md", "**/*.txt"]`): File patterns to include.
- `exclude` (string[], optional, default: `[]`): File patterns to exclude.
- `token` (string, optional): Dedicated token for this repository (overrides `GH_PAT`).

### Web Source Fields
- `name` (string, required): Unique identifier for the source.
- `type` (`"web"`, required): Source type.
- `url` (string, required): Starting webpage URL.
- `maxDepth` (number, optional, default: `2`): Maximum crawl depth.
- `urlPattern` (string, optional): Regular expression string to filter crawled URLs.
- `headers` (record, optional): Custom HTTP headers for requests.

---

## Manual & Local Usage

### Running Synchronization Locally

```bash
TIDB_DATABASE_URL="mysql://user:pass@gateway.tidbcloud.com:4000/test" \
CONFIG_JSON='[{"name":"notes","type":"git","url":"https://github.com/user/notes.git"}]' \
pnpm start
```

### Clearing Indexed Data Locally

To clear a specific source:

```bash
TIDB_DATABASE_URL="mysql://..." pnpm clear -- personal-notes
```

To clear all knowledge base data and reset synchronization states:

```bash
TIDB_DATABASE_URL="mysql://..." pnpm clear
```

## License

This project is licensed under the [MIT License](LICENSE).
