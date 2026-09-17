# tidb-knowbase-indexer

Automated incremental knowledge base indexer with vector embeddings and TiDB Cloud Starter storage.

## Overview

`tidb-knowbase-indexer` synchronizes documents periodically via GitHub Actions (or locally) from multiple sources directly into TiDB Cloud:
- **Private & Public Git Repositories**: Incremental indexing based on Git commit diffs (`git diff <lastCommit> HEAD`). Automatically supports token-based authentication for private repositories without needing SSH keys.
- **Websites & Blogs**: Recursively crawls web pages and extracts clean content.
- **Privacy Filter (`#confidential`)**: Automatically skips Markdown notes tagged with `#confidential` (in YAML frontmatter or inline body text), preventing sensitive notes from being indexed.
- **Direct Vector Embedding & Storage**: Generates high-dimensional vector embeddings for each document chunk and writes vectors directly to TiDB Cloud Starter using TiDB's native `VECTOR` column and vector distance functions.
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
                                    │
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

## Configuration

Configure the following GitHub Actions Secrets (or `.env` file for local runs):

| Secret / Variable | Description | Required | Default |
|---|---|---|---|
| `CONFIG_JSON` | JSON array configuring data sources | Yes | - |
| `TIDB_DATABASE_URL` | Connection URL to TiDB Cloud Starter (e.g. `mysql://user:pass@gateway.tidbcloud.com:4000/test?ssl={"minVersion":"TLSv1.2"}`) | Yes (or TIDB_HOST+TIDB_USER) | - |
| `EMBEDDING_API_KEY` | API key for the embedding provider | Yes (unless mock) | - |
| `EMBEDDING_PROVIDER` | `openai` (works with SiliconFlow/Ollama/OpenAI), `huggingface`, `gemini`, or `mock` | No | `openai` |
| `EMBEDDING_BASE_URL` | API base URL for OpenAI-compatible provider | No | `https://api.siliconflow.cn/v1` |
| `EMBEDDING_MODEL` | Embedding model identifier | No | `BAAI/bge-m3` |
| `EMBEDDING_DIMENSION` | Vector dimension size | No | `1024` |
| `GH_PAT` | GitHub Personal Access Token with repo read access for private repositories | Optional | - |

### `CONFIG_JSON` Example

```json
[
  {
    "name": "personal-notes",
    "type": "git",
    "url": "https://github.com/username/notes.git",
    "branch": "main",
    "include": ["**/*.md", "**/*.txt"],
    "exclude": [".trash/**", "templates/**"]
  },
  {
    "name": "blog",
    "type": "web",
    "url": "https://example.com/blog",
    "maxDepth": 2,
    "urlPattern": "https://example.com/blog/.*"
  }
]
```

## Manual & Local Usage

### Running Synchronization

```bash
TIDB_DATABASE_URL="mysql://user:pass@gateway.tidbcloud.com:4000/test" \
EMBEDDING_API_KEY="sk-..." \
CONFIG_JSON='[{"name":"notes","type":"git","url":"https://github.com/user/notes.git"}]' \
pnpm start
```

### Clearing Indexed Data

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
