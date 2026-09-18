# tidb-knowbase-indexer

Automated incremental knowledge base indexer supporting Cloudflare Workers AI embedding and TiDB Cloud native Auto Embedding with vector storage.

## Overview

`tidb-knowbase-indexer` synchronizes documents periodically via GitHub Actions (or locally) from multiple sources directly into TiDB Cloud:
- **Supported Embedding Providers**:
  - **Cloudflare Workers AI (`@cf/baai/bge-m3`, 1024-dim)**: 100% free with 10,000 Neurons/day (approx. 9.3M tokens/day, ~15,000-20,000 chunks/day). High speed, zero cold start. Ideal for domestic PingCAP Cloud China (`console.cloud.pingkai.cn`) and global TiDB Cloud alike.
  - **TiDB Cloud Native Auto Embedding (`tidb_auto`)**: Built-in zero-key embedding for global AWS TiDB Cloud Starter clusters using `EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", text)`.
  - **Self-Healing Schema Migration**: Automatically detects whether the database table uses an Auto Embedding generated column or client-side `VECTOR(dim)` column and re-provisions cleanly if switching modes.
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

### Scenario A: PingCAP Cloud China (`console.cloud.pingkai.cn`) or Global TiDB Cloud via Cloudflare Workers AI

PingCAP Cloud China clusters run on domestic infrastructure where `tidbcloud_free` is not available. Cloudflare Workers AI provides free, high-performance embedding with zero cold start:

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/), copy your **Account ID**.
2. Create an API Token under **My Profile -> API Tokens** with `Workers AI: Read` permission.
3. Configure GitHub Secrets / Variables:
   - **Secrets**:
     - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API Token.
     - `CLOUDFLARE_ACCOUNT_ID`: Your 32-character Cloudflare Account ID.
     - `TIDB_DATABASE_URL`: Your PingCAP Cloud or TiDB Cloud connection string.
     - `CONFIG_JSON`: Data source configuration.
   - **Variables** (optional, defaults are already preconfigured):
     - `EMBEDDING_PROVIDER`: `cloudflare`
     - `CLOUDFLARE_MODEL`: `@cf/baai/bge-m3`
     - `EMBEDDING_DIMENSION`: `1024`

### Scenario B: TiDB Cloud Global (`tidbcloud.com` on AWS) via Native Auto Embedding

Global AWS clusters support built-in zero-configuration Auto Embedding:
1. Set `EMBEDDING_PROVIDER`: `tidb_auto`
2. No external embedding API key or token is required!

## GitHub Actions Workflows & Parameters

In your GitHub repository, navigate to **Settings -> Secrets and variables -> Actions** to configure the following secrets and variables:

### 1. Repository Secrets (Sensitive Credentials)

Configure these in the **Secrets** tab:

| Secret Name | Required | Description | Example |
|---|:---:|---|---|
| `CONFIG_JSON` | **Yes** | JSON array configuring data sources (Git repositories or Web URLs). | `[{"name":"notes","type":"git","url":"..."}]` |
| `TIDB_DATABASE_URL` | **Yes** | Connection string for TiDB Cloud Starter. TLS 1.2+ is enforced automatically. | `mysql://<user>:<password>@gateway.tidbcloud.com:4000/test?ssl={"minVersion":"TLSv1.2"}` |
| `CLOUDFLARE_API_TOKEN` | Required for Cloudflare | Cloudflare API Token with Workers AI Read permission (or `EMBEDDING_API_KEY`). | `Bearer ...` |
| `CLOUDFLARE_ACCOUNT_ID` | Required for Cloudflare | Cloudflare 32-character Account ID. | `0123456789abcdef0123456789abcdef` |
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
| `EMBEDDING_PROVIDER` | No | `cloudflare` | Embedding provider: `cloudflare` (or `cf`), `tidb_auto` (or `auto`), `mock`. |
| `CLOUDFLARE_MODEL` | No | `@cf/baai/bge-m3` | Embedding model identifier on Cloudflare. |
| `CLOUDFLARE_BASE_URL` | No | `https://api.cloudflare.com/client/v4` | Optional custom Cloudflare base URL or AI Gateway URL. |
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
