# tidb-knowbase-indexer

Automated incremental knowledge base indexer with vector embeddings and TiDB Cloud Starter storage.

## Overview

`tidb-knowbase-indexer` synchronizes documents periodically via GitHub Actions (or locally) from multiple sources directly into TiDB Cloud:
- **Private & Public Git Repositories**: Incremental indexing based on Git commit diffs (`git diff <lastCommit> HEAD`). Automatically supports token-based authentication for private repositories without needing SSH keys.
- **Websites & Blogs**: Recursively crawls web pages and extracts clean content.
- **Privacy Filter (`#confidential`)**: Automatically skips Markdown notes tagged with `#confidential` (in YAML frontmatter or inline body text), preventing sensitive notes from being indexed.
- **Direct Vector Embedding & Storage**: Generates high-dimensional vector embeddings for each document chunk and writes vectors directly to TiDB Cloud Starter using TiDB's native `VECTOR` column and vector distance functions.
- **Enforced TLS Security**: Enforces TLS 1.2+ with certificate validation for all connections to TiDB Cloud Serverless.
- **Zero-Cost Architecture**: Runs on GitHub Actions free tier, uses TiDB Cloud Starter (free 5 GiB storage and 50M Request Units/month), and works with free embedding models (such as SiliconFlow free `BAAI/bge-m3`, Hugging Face free Inference API, or Google Gemini free tier).
- **Log Sanitization**: Uses GitHub Actions secret masking (`@actions/core.setSecret`) to prevent leakage of database credentials, private URLs, and tokens into execution logs.

## Architecture

```
[ Git / Web Sources ]
        │
        ▼
 [ Chunking & Hashing ] ──(Commit Diff & #confidential filter)──┐
        │                                                        │
        ▼                                                        ▼
 [ Embedding Generation ]                              [ Calculate Diff ]
 (SiliconFlow / HF / Gemini)                                     │
        │                                                        │
        └───────────────────────────┬────────────────────────────┘
                                    │ (TLS 1.2+ Enforced)
                                    ▼
                         [ TiDB Cloud Starter ]
                  - chunks: VECTOR(1024) embeddings
                  - sync_state: incremental hash tracking
```

## Free Tier Setup

1. **TiDB Cloud Starter (100% Free)**:
   - Sign up for [TiDB Cloud](https://tidbcloud.com/) and create a free Serverless (Starter) cluster.
   - Obtain your connection string or credentials from the cluster overview page (`mysql://...`).
2. **Free Embedding Provider**:
   - **SiliconFlow**: Register at [SiliconFlow](https://siliconflow.cn/) and get a free API key. SiliconFlow provides free hosting for `BAAI/bge-m3` (1024 dimensions).
   - **Hugging Face**: Use any free Hugging Face User Access Token with `BAAI/bge-m3`.
   - **Google Gemini**: Obtain a free API key from Google AI Studio and use `text-embedding-004` (768 dimensions).
3. **GitHub Actions**:
   - Runs automatically on the GitHub Actions free tier.

---

## GitHub Actions Workflows & Parameters

In your GitHub repository, navigate to **Settings -> Secrets and variables -> Actions** to configure the following secrets and variables:

### 1. Repository Secrets (Sensitive Credentials)

Configure these in the **Secrets** tab:

| Secret Name | Required | Description | Example |
|---|:---:|---|---|
| `CONFIG_JSON` | **Yes** | JSON array configuring data sources (Git repositories or Web URLs). | `[{"name":"notes","type":"git","url":"..."}]` |
| `TIDB_DATABASE_URL` | **Yes** | Connection string for TiDB Cloud Starter. TLS 1.2+ is enforced automatically. | `mysql://<user>:<password>@gateway.tidbcloud.com:4000/test?ssl={"minVersion":"TLSv1.2"}` |
| `EMBEDDING_API_KEY` | **Yes** | API key for embedding generation (e.g. SiliconFlow token or OpenAI key). | `sk-...` |
| `GH_PAT` | Optional | GitHub Personal Access Token with repository read permissions for private Git sources. | `ghp_...` |
| `TIDB_HOST` | Optional | TiDB host address (alternative if `TIDB_DATABASE_URL` is omitted). | `gateway01.us-east-1.prod.aws.tidbcloud.com` |
| `TIDB_PORT` | Optional | TiDB port (defaults to `4000`). | `4000` |
| `TIDB_USER` | Optional | TiDB username (alternative if `TIDB_DATABASE_URL` is omitted). | `xxxxxx.root` |
| `TIDB_PASSWORD` | Optional | TiDB password (alternative if `TIDB_DATABASE_URL` is omitted). | `password` |
| `TIDB_DATABASE` | Optional | TiDB database name (defaults to `test`). | `test` |

### 2. Repository Variables (Non-Sensitive Configuration)

Configure these in the **Variables** tab:

| Variable Name | Required | Default | Allowed Values / Description |
|---|:---:|:---:|---|
| `EMBEDDING_PROVIDER` | No | `openai` | `openai` (SiliconFlow / OpenAI / Ollama), `huggingface`, `gemini`, `mock` |
| `EMBEDDING_BASE_URL` | No | `https://api.siliconflow.cn/v1` | Base URL for OpenAI-compatible embedding API. |
| `EMBEDDING_MODEL` | No | `BAAI/bge-m3` | Model identifier (e.g. `BAAI/bge-m3` or `text-embedding-004`). |
| `EMBEDDING_DIMENSION` | No | `1024` | Vector dimension size (1024 for `bge-m3`, 768 for `text-embedding-004`). |
| `TIDB_SSL` | No | `true` | Enforces TLS connection to TiDB Cloud. |
| `TIDB_SSL_REJECT_UNAUTHORIZED` | No | `true` | Validates server CA certificate against trusted root CAs. |

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
EMBEDDING_API_KEY="sk-..." \
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
