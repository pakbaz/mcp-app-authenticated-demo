import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { TodoStore, TodoFilter } from "./store/cosmos-store.js";
import { getUserProfile } from "./auth/obo-helper.js";
import { todoAppHtml } from "./ui/todo-app.js";

const UI_RESOURCE_URI = "ui://todo-app/view.html";

/**
 * Register all MCP tools and resources on the given server instance.
 */
export function registerTools(server: McpServer, store: TodoStore): void {
  // ══════════════════════════════════════════════════════════════════════
  // UI Resource — the interactive Todo app panel
  // ══════════════════════════════════════════════════════════════════════

  registerAppResource(
    server,
    "Todo App UI",
    UI_RESOURCE_URI,
    {
      description: "Interactive Todo list UI panel",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          csp: {
            resourceDomains: ["https://esm.sh"],
          },
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: todoAppHtml(),
        },
      ],
    })
  );

  // ══════════════════════════════════════════════════════════════════════
  // list_todos — visible to both model and app UI
  // ══════════════════════════════════════════════════════════════════════

  registerAppTool(
    server,
    "list_todos",
    {
      title: "List Todos",
      description:
        "List all todo items for the authenticated user. Returns todos with stats. " +
        "Filter by 'all', 'active', or 'completed'.",
      inputSchema: {
        filter: z
          .enum(["all", "active", "completed"])
          .optional()
          .describe("Filter: all, active, or completed"),
      },
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ filter }, extra) => {
      const userId = extractUserId(extra);
      if (!userId) return authError();

      const filterVal: TodoFilter = (filter as TodoFilter) || "all";
      const todos = await store.listTodos(userId, filterVal);
      const stats = await store.getStats(userId);
      const userName = extractUserName(extra);

      const structured = {
        action: "list",
        todos,
        stats,
        user_name: userName || "User",
        user_id: userId,
        filter: filterVal,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${todos.length} ${filterVal} todo(s). Active: ${stats.active}, Completed: ${stats.completed}`,
          },
        ],
        structuredContent: structured,
      };
    }
  );

  // ══════════════════════════════════════════════════════════════════════
  // add_todo — visible to both model and app UI
  // ══════════════════════════════════════════════════════════════════════

  registerAppTool(
    server,
    "add_todo",
    {
      title: "Add Todo",
      description: "Add a new todo item for the authenticated user.",
      inputSchema: {
        title: z.string().describe("Title of the todo item"),
        description: z
          .string()
          .optional()
          .describe("Optional description"),
      },
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ title, description }, extra) => {
      const userId = extractUserId(extra);
      if (!userId) return authError();

      const todo = await store.createTodo(userId, title, description || "");
      const stats = await store.getStats(userId);

      return {
        content: [
          { type: "text" as const, text: `Created todo: "${todo.title}"` },
        ],
        structuredContent: { action: "created", todo, stats },
      };
    }
  );

  // ══════════════════════════════════════════════════════════════════════
  // toggle_todo — app-only (callable from UI, hidden from LLM)
  // ══════════════════════════════════════════════════════════════════════

  registerAppTool(
    server,
    "toggle_todo",
    {
      title: "Toggle Todo",
      description: "Mark a todo as complete or incomplete.",
      inputSchema: {
        todo_id: z.string().describe("ID of the todo to toggle"),
      },
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async ({ todo_id }, extra) => {
      const userId = extractUserId(extra);
      if (!userId) return authError();

      const todo = await store.toggleTodo(userId, todo_id);
      if (!todo) return notFoundError(todo_id);

      const stats = await store.getStats(userId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Toggled "${todo.title}" → ${todo.completed ? "completed" : "active"}`,
          },
        ],
        structuredContent: { action: "toggled", todo, stats },
      };
    }
  );

  // ══════════════════════════════════════════════════════════════════════
  // edit_todo — app-only
  // ══════════════════════════════════════════════════════════════════════

  registerAppTool(
    server,
    "edit_todo",
    {
      title: "Edit Todo",
      description: "Update the title and/or description of a todo.",
      inputSchema: {
        todo_id: z.string().describe("ID of the todo to edit"),
        title: z.string().describe("New title"),
        description: z
          .string()
          .optional()
          .describe("New description"),
      },
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async ({ todo_id, title, description }, extra) => {
      const userId = extractUserId(extra);
      if (!userId) return authError();

      const todo = await store.updateTodo(userId, todo_id, {
        title,
        description,
      });
      if (!todo) return notFoundError(todo_id);

      const stats = await store.getStats(userId);
      return {
        content: [
          { type: "text" as const, text: `Updated todo: "${todo.title}"` },
        ],
        structuredContent: { action: "updated", todo, stats },
      };
    }
  );

  // ══════════════════════════════════════════════════════════════════════
  // delete_todo — app-only
  // ══════════════════════════════════════════════════════════════════════

  registerAppTool(
    server,
    "delete_todo",
    {
      title: "Delete Todo",
      description: "Delete a todo item permanently.",
      inputSchema: {
        todo_id: z.string().describe("ID of the todo to delete"),
      },
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async ({ todo_id }, extra) => {
      const userId = extractUserId(extra);
      if (!userId) return authError();

      const deleted = await store.deleteTodo(userId, todo_id);
      if (!deleted) return notFoundError(todo_id);

      const stats = await store.getStats(userId);
      return {
        content: [{ type: "text" as const, text: `Deleted todo ${todo_id}` }],
        structuredContent: { action: "deleted", todoId: todo_id, stats },
      };
    }
  );

  // ══════════════════════════════════════════════════════════════════════
  // get_user_info — uses OBO to fetch user profile from Graph
  // ══════════════════════════════════════════════════════════════════════

  registerAppTool(
    server,
    "get_user_info",
    {
      title: "Get User Info",
      description:
        "Get the authenticated user's profile (name, email) via Microsoft Graph.",
      inputSchema: {},
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async (_args, extra) => {
      const token = extractToken(extra);
      if (!token) return authError();

      try {
        const profile = await getUserProfile(token);
        return {
          content: [
            {
              type: "text" as const,
              text: `User: ${profile.displayName} (${profile.mail || profile.userPrincipalName})`,
            },
          ],
          structuredContent: {
            action: "user_info",
            displayName: profile.displayName,
            email: profile.mail || profile.userPrincipalName,
            id: profile.id,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get user info: ${(err as Error).message}`,
            },
          ],
          structuredContent: {
            action: "error",
            message: `Failed to get user info: ${(err as Error).message}`,
          },
          isError: true,
        };
      }
    }
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract user ID from the tool's extra context.
 * The auth middleware sets `req.auth` which flows through as `authInfo` on the transport.
 */
function extractUserId(extra: unknown): string | null {
  const e = extra as {
    authInfo?: { token: string; claims?: { oid?: string } };
    _meta?: { authInfo?: { token: string; claims?: { oid?: string } } };
  };
  return (
    e?.authInfo?.claims?.oid ??
    e?._meta?.authInfo?.claims?.oid ??
    // Fallback: check if we set it on the request context
    (extra as Record<string, unknown>)?.["userId"] as string ??
    null
  );
}

function extractUserName(extra: unknown): string | null {
  const e = extra as {
    authInfo?: { claims?: { name?: string } };
    _meta?: { authInfo?: { claims?: { name?: string } } };
  };
  return (
    e?.authInfo?.claims?.name ??
    e?._meta?.authInfo?.claims?.name ??
    null
  );
}

function extractToken(extra: unknown): string | null {
  const e = extra as {
    authInfo?: { token?: string };
    _meta?: { authInfo?: { token?: string } };
  };
  return e?.authInfo?.token ?? e?._meta?.authInfo?.token ?? null;
}

function authError() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Authentication required. Please sign in with your Entra ID account.",
      },
    ],
    structuredContent: {
      action: "error",
      message: "Authentication required",
    },
    isError: true,
  };
}

function notFoundError(todoId: string) {
  return {
    content: [
      { type: "text" as const, text: `Todo not found: ${todoId}` },
    ],
    structuredContent: {
      action: "error",
      message: `Todo not found: ${todoId}`,
    },
    isError: true,
  };
}
