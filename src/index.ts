/**
 * GitHub DeepBlame MCP Server
 * 
 * This server provides tools to deeply analyze the history of a file in a GitHub repository.
 * It goes beyond standard git blame by retrieving comprehensive information about pull requests
 * that modified a specific file, including PR details, comments, reviews, and related issues.
 * 
 * The server implements a two-step workflow:
 * 1. github_list_prs_for_file: Lists PR numbers that modified a specific file, with commits pagination
 * 2. github_get_pr_details: Gets detailed information about specified PRs, with pseudo-pagination
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Configuration constants for easier adjustment
const COMMITS_PER_PAGE = 20;  // Number of commits to fetch per page in github_list_prs_for_file
const MAX_PRS_PER_REQUEST = 20;  // Maximum number of PRs to process in a single github_get_pr_details request

// Initialize the MCP server
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

/**
 * Schema for the first tool: github_list_prs_for_file
 * 
 * This tool retrieves commits that modified a specific file and finds associated PRs.
 * It supports pagination of commits and time period filtering.
 */
const listPRsInputSchema = z.object({
  owner: z.string().describe("The GitHub username or organization name that owns the repository"),
  repo: z.string().describe("The name of the GitHub repository containing the target file"),
  path: z.string().describe("The relative file path within the repository (e.g., 'src/index.js', 'README.md')"),
  page: z.number().optional().default(1).describe(`The page number for commits pagination (default: 1)`),
  since: z.string().optional().describe("Only show commits after this timestamp (ISO 8601 format, e.g., '2023-01-01T00:00:00Z')"),
  until: z.string().optional().describe("Only show commits before this timestamp (ISO 8601 format, e.g., '2023-12-31T23:59:59Z')"),
  ignoreDependabot: z.boolean().optional().default(true).describe("Whether to ignore PRs created by Dependabot (default: true)"),
});

/**
 * Schema for the second tool: github_get_pr_details
 * 
 * This tool retrieves detailed information about specified PRs.
 * It implements pseudo-pagination by processing a limited number of PRs per request
 * and returning the remaining PR numbers for subsequent requests.
 */
const getPRDetailsInputSchema = z.object({
  owner: z.string().describe("The GitHub username or organization name that owns the repository"),
  repo: z.string().describe("The name of the GitHub repository containing the target file"),
  pr_numbers: z.array(z.number()).describe("Array of PR numbers to get details for. Initially send all PR numbers obtained from github_list_prs_for_file. If the response includes 'remaining_pr_numbers', send those in the next request."),
  path: z.string().optional().describe("The relative file path within the repository (optional, for file-specific details)"),
});

/**
 * Register the tools with the MCP server
 * 
 * This handler defines the tools available to MCP clients, including their
 * names, descriptions, and input schemas.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "github_list_prs_for_file",
        description: "Lists pull request numbers that modified a specific file in a GitHub repository, with commits pagination support. This tool retrieves commits that modified the file and finds associated PRs. Use this tool multiple times with different pagination parameters to collect all relevant PRs before proceeding to github_get_pr_details.",
        inputSchema: zodToJsonSchema(listPRsInputSchema),
      },
      {
        name: "github_get_pr_details",
        description: `Retrieves detailed information about specified pull requests, including PR details, comments, review comments, reviews, file changes, and related issues. The tool implements pseudo-pagination: initially send all PR numbers obtained from github_list_prs_for_file, and if not all can be processed at once, the response will include 'remaining_pr_numbers' that should be sent in a subsequent request. This process continues until all PRs are processed.`,
        inputSchema: zodToJsonSchema(getPRDetailsInputSchema),
      },
    ],
  };
});

/**
 * Handle tool execution requests
 * 
 * This handler processes requests to execute either of the two tools:
 * - github_list_prs_for_file: Lists PRs that modified a file
 * - github_get_pr_details: Gets detailed information about specified PRs
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!request.params.arguments) {
    throw new Error("Arguments are required");
  }
  
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  switch (request.params.name) {
    // Handle github_list_prs_for_file tool execution
    case "github_list_prs_for_file": {
      const input = listPRsInputSchema.parse(request.params.arguments);
      const output: { pr_numbers: number[], has_more: boolean, page: number } = { 
        pr_numbers: [], 
        has_more: false,
        page: input.page,
      };

      // Get commits with pagination and time period filtering
      // This fetches commits that modified the specified file, with support for
      // pagination and filtering by time period using since/until parameters
      const commits = await octokit.repos.listCommits({
        owner: input.owner,
        repo: input.repo,
        path: input.path,
        page: input.page,
        per_page: COMMITS_PER_PAGE,
        ...(input.since ? { since: input.since } : {}),
        ...(input.until ? { until: input.until } : {}),
      });

      const pullNumbers = new Set<number>();
      
      // Check if there might be more pages of commits
      // If we received a full page of commits, there might be more pages available
      output.has_more = commits.data.length === COMMITS_PER_PAGE;

      // For each commit, get associated PRs
      // This finds all PRs that include each commit, building a unique set of PR numbers
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
      
      output.pr_numbers = Array.from(pullNumbers);
      
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
    
    // Handle github_get_pr_details tool execution
    case "github_get_pr_details": {
      const input = getPRDetailsInputSchema.parse(request.params.arguments);
      const output: { pullRequests: any[], remaining_pr_numbers: number[] } = { 
        pullRequests: [],
        remaining_pr_numbers: [] 
      };
      
      // Ensure uniqueness of PR numbers to avoid duplicate processing
      const uniquePRNumbers = [...new Set(input.pr_numbers)];
      
      // Process only up to MAX_PRS_PER_REQUEST PRs at a time
      // This implements the pseudo-pagination mechanism
      const prsToProcess = uniquePRNumbers.slice(0, MAX_PRS_PER_REQUEST);
      
      // Store remaining PRs for the next request
      // The client should send these PR numbers in a subsequent request
      output.remaining_pr_numbers = uniquePRNumbers.slice(MAX_PRS_PER_REQUEST);
      
      for (const pullNumber of prsToProcess) {
        const pull = await octokit.rest.pulls.get({
          owner: input.owner,
          repo: input.repo,
          pull_number: pullNumber,
        });
        
        let file = null;
        if (input.path) {
          const files = await octokit.rest.pulls.listFiles({
            owner: input.owner,
            repo: input.repo,
            pull_number: pullNumber,
          });
          file = files.data.find((f) => f.filename === input.path);
        }
        
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
        
        // Extract and fetch related issues from PR body
        // This finds GitHub issue references in the PR description and fetches their details
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
          user_login: pull.data.user?.login,
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

/**
 * Main function to start the MCP server
 * 
 * This initializes the server with a stdio transport and starts listening for requests.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitHub DeepBlame MCP Server running on stdio");
}

// Start the server and handle any fatal errors
main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
