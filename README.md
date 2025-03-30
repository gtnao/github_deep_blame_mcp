# GitHub DeepBlame MCP Server

## build

```bash
npm install
npm run build
```

## configuration

```json
{
  "mcpServers": {
    "github_deep_blame": {
      "command": "node",
      "args": ["<your_path>/build/index.js"],
      "env": {
        "GITHUB_TOKEN": "<your_personal_access_token>"
      }
    }
  }
}
```
