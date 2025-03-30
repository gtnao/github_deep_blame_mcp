import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const server = new Server(
  {
    name: "github_deep_blame",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const inputSchema = z.object({
  owner: z.string().describe("The owner of the repository"),
  repo: z.string().describe("The name of the repository"),
  path: z.string().describe("The path to the file in the repository"),
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "github_deep_blame",
        description: "Deeply blame a file in a GitHub repository",
        inputSchema: zodToJsonSchema(inputSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!request.params.arguments) {
    throw new Error("Arguments are required");
  }
  switch (request.params.name) {
    case "github_deep_blame": {
      const input = inputSchema.parse(request.params.arguments);
      const output: { pullRequests: any[] } = { pullRequests: [] };
      const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
      });
      const commits = await octokit.repos.listCommits({
        owner: input.owner,
        repo: input.repo,
        path: input.path,
      });
      const pullNumbers = new Set<number>();
      for (const commit of commits.data) {
        const pulls = await octokit.repos.listPullRequestsAssociatedWithCommit({
          owner: input.owner,
          repo: input.repo,
          commit_sha: commit.sha,
        });
        for (const pull of pulls.data) {
          pullNumbers.add(pull.number);
        }
      }
      for (const pullNumber of pullNumbers) {
        const pull = await octokit.rest.pulls.get({
          owner: input.owner,
          repo: input.repo,
          pull_number: pullNumber,
        });
        const files = await octokit.rest.pulls.listFiles({
          owner: input.owner,
          repo: input.repo,
          pull_number: pullNumber,
        });
        const file = files.data.find((file) => file.filename === input.path);
        const commentsRes = await octokit.rest.issues.listComments({
          owner: input.owner,
          repo: input.repo,
          issue_number: pullNumber,
        });
        const reviewCommentsRes = await octokit.rest.pulls.listReviewComments({
          owner: input.owner,
          repo: input.repo,
          pull_number: pullNumber,
        });
        const reviewsRes = await octokit.rest.pulls.listReviews({
          owner: input.owner,
          repo: input.repo,
          pull_number: pullNumber,
        });
        output.pullRequests.push({
          number: pull.data.number,
          state: pull.data.state,
          title: pull.data.title,
          body: pull.data.body,
          user_login: pull.data.user.login,
          html_url: pull.data.html_url,
          created_at: pull.data.created_at,
          updated_at: pull.data.updated_at,
          closed_at: pull.data.closed_at,
          merged_at: pull.data.merged_at,
          comments: commentsRes.data.map((comment) => ({
            body: comment.body,
            user_login: comment.user?.login,
            html_url: comment.html_url,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
          })),
          reviewComments: reviewCommentsRes.data.map((reviewComment) => ({
            body: reviewComment.body,
            user_login: reviewComment.user?.login,
            html_url: reviewComment.html_url,
            created_at: reviewComment.created_at,
            updated_at: reviewComment.updated_at,
          })),
          reviews: reviewsRes.data.map((review) => ({
            body: review.body,
            state: review.state,
            user_login: review.user?.login,
            html_url: review.html_url,
            submitted_at: review.submitted_at,
          })),
          ...(file != null
            ? {
                file: {
                  patch: file.patch,
                  additions: file.additions,
                  deletions: file.deletions,
                  changes: file.changes,
                  raw_url: file.raw_url,
                },
              }
            : {}),
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
    default: {
      throw new Error(`Unknown tool name: ${request.params.name}`);
    }
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitHub DeepBlame MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
