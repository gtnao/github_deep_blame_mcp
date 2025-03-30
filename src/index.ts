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
  owner: z.string().describe("The GitHub username or organization name that owns the repository"),
  repo: z.string().describe("The name of the GitHub repository containing the target file"),
  path: z.string().describe("The relative file path within the repository (e.g., 'src/index.js', 'README.md')"),
  ignoreDependabot: z.boolean().default(true).describe("Whether to ignore PRs created by Dependabot (default: true)"),
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "github_deep_blame",
        description: "Performs a comprehensive analysis of a file's history in a GitHub repository, retrieving detailed information about all pull requests that modified the file, including PR details, comments, review comments, reviews, file changes, and related issues. This tool provides much richer context than standard git blame, helping to understand the complete evolution and decision history of a file.",
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
          if (input.ignoreDependabot && 
              pull.user?.login === "dependabot[bot]") {
            continue;
          }
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
        const issueURLRegex =
          /https:\/\/github.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/g;
        const issueMatches = [
          ...(pull.data.body?.matchAll(issueURLRegex) || []),
        ];
        const issues = [];
        const alreadyFetchedIssues = new Set<string>();
        for (const issueMatch of issueMatches) {
          const key = `${issueMatch[1]}/${issueMatch[2]}/${issueMatch[3]}`;
          if (alreadyFetchedIssues.has(key)) {
            continue;
          }
          alreadyFetchedIssues.add(key);
          try {
            const issuesRes = await octokit.rest.issues.get({
              owner: issueMatch[1],
              repo: issueMatch[2],
              issue_number: parseInt(issueMatch[3]),
            });
            issues.push({
              owner: issueMatch[1],
              repo: issueMatch[2],
              number: issuesRes.data.number,
              title: issuesRes.data.title,
              body: issuesRes.data.body,
              user_login: issuesRes.data.user?.login,
              html_url: issuesRes.data.html_url,
              created_at: issuesRes.data.created_at,
              updated_at: issuesRes.data.updated_at,
              closed_at: issuesRes.data.closed_at,
            });
          } catch (error) {}
        }
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
          issues,
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
