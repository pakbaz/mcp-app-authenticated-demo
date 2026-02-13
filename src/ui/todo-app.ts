import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pre-load the bundled ext-apps SDK (IIFE, sets window.McpExtApps)
const extAppsBundleCode = readFileSync(
  resolve(__dirname, "ext-apps-bundle.js"),
  "utf-8"
);

/**
 * Self-contained HTML template for the Todo MCP App UI.
 *
 * This renders inside a sandboxed iframe in the MCP host (VS Code Copilot Chat).
 * The ext-apps SDK is inlined to avoid CSP issues with external CDN imports.
 *
 * The UI communicates with the MCP server by calling `app.callServerTool()`
 * for CRUD operations. Tools with `visibility: ["app"]` are callable from
 * this UI but hidden from the LLM.
 */
export function todoAppHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <title>Todo App</title>
  <style>
    :root {
      --bg: #ffffff;
      --fg: #1e1e1e;
      --border: #e0e0e0;
      --accent: #0078d4;
      --accent-hover: #106ebe;
      --danger: #d13438;
      --danger-hover: #a4262c;
      --success: #107c10;
      --muted: #6e6e6e;
      --card-bg: #f9f9f9;
      --input-bg: #ffffff;
      --completed-fg: #999999;
      --badge-bg: #e8e8e8;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1e1e1e;
        --fg: #cccccc;
        --border: #3e3e3e;
        --accent: #4fc3f7;
        --accent-hover: #29b6f6;
        --danger: #f44747;
        --danger-hover: #e53935;
        --success: #4caf50;
        --muted: #888888;
        --card-bg: #252526;
        --input-bg: #2d2d2d;
        --completed-fg: #666666;
        --badge-bg: #333333;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      font-size: 13px;
      line-height: 1.5;
      padding: 12px;
      min-height: 100%;
    }

    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .app-title {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .user-name {
      font-size: 12px;
      color: var(--muted);
      font-weight: 400;
    }

    .stats {
      display: flex;
      gap: 8px;
      font-size: 11px;
    }

    .stat-badge {
      background: var(--badge-bg);
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 500;
    }

    .stat-badge.active { color: var(--accent); }
    .stat-badge.done { color: var(--success); }

    /* ── Add Form ── */
    .add-form {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
    }

    .add-form input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--input-bg);
      color: var(--fg);
      font-size: 13px;
      outline: none;
    }

    .add-form input:focus { border-color: var(--accent); }

    .btn {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.15s;
    }

    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-danger { background: transparent; color: var(--danger); }
    .btn-danger:hover { background: var(--danger); color: #fff; }
    .btn-icon {
      background: transparent;
      border: none;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 3px;
      font-size: 14px;
      line-height: 1;
      color: var(--muted);
    }
    .btn-icon:hover { background: var(--badge-bg); color: var(--fg); }

    /* ── Filter Tabs ── */
    .filter-bar {
      display: flex;
      gap: 4px;
      margin-bottom: 10px;
    }

    .filter-btn {
      padding: 4px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: transparent;
      color: var(--fg);
      cursor: pointer;
      font-size: 12px;
    }

    .filter-btn.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }

    /* ── Todo List ── */
    .todo-list {
      list-style: none;
    }

    .todo-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
      transition: background 0.1s;
    }

    .todo-item:hover { background: var(--card-bg); }
    .todo-item.completed .todo-title { text-decoration: line-through; color: var(--completed-fg); }
    .todo-item.completed .todo-desc { color: var(--completed-fg); }

    .todo-checkbox {
      width: 18px;
      height: 18px;
      margin-top: 1px;
      accent-color: var(--accent);
      cursor: pointer;
      flex-shrink: 0;
    }

    .todo-content {
      flex: 1;
      min-width: 0;
    }

    .todo-title {
      font-weight: 500;
      word-break: break-word;
    }

    .todo-desc {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
      word-break: break-word;
    }

    .todo-actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s;
      flex-shrink: 0;
    }

    .todo-item:hover .todo-actions { opacity: 1; }

    /* ── Edit Mode ── */
    .edit-form {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
    }

    .edit-form input {
      padding: 4px 8px;
      border: 1px solid var(--accent);
      border-radius: 3px;
      background: var(--input-bg);
      color: var(--fg);
      font-size: 13px;
      outline: none;
    }

    .edit-actions {
      display: flex;
      gap: 4px;
    }

    .empty-state {
      text-align: center;
      padding: 24px;
      color: var(--muted);
      font-size: 13px;
    }

    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: var(--muted);
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin-right: 8px;
    }

    @keyframes spin { to { transform: rotate(360deg); }}

    .error-msg {
      background: var(--danger);
      color: #fff;
      padding: 6px 12px;
      border-radius: 4px;
      margin-bottom: 8px;
      font-size: 12px;
    }

    .auth-required {
      text-align: center;
      padding: 32px 16px;
      color: var(--muted);
    }

    .auth-required h3 { margin-bottom: 8px; color: var(--fg); }
  </style>
</head>
<body>
  <div id="app">
    <div class="loading"><div class="spinner"></div>Connecting...</div>
  </div>

  <!-- Inlined ext-apps SDK (avoids CSP issues with external CDN) -->
  <script>${extAppsBundleCode}</script>

  <script>
    const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = McpExtApps;

    // Signal that the SDK loaded (for debugging)
    console.log("[todo-app] ext-apps SDK loaded (inlined)");

    // ── State ──
    let todos = [];
    let currentFilter = "all";
    let editingId = null;
    let userName = "";
    let userId = null;
    let isLoading = false;
    let errorMsg = "";

    // ── MCP App ──
    const app = new App(
      { name: "Todo App", version: "1.0.0" },
      { tools: { listChanged: true } },
      { autoResize: true }
    );

    app.onteardown = async () => ({ });

    // When a tool result comes back, re-render
    app.ontoolinput = (params) => {
      if (params.structuredContent) {
        handleStructuredContent(params.structuredContent);
      }
    };

    app.ontoolresult = (result) => {
      if (result.structuredContent) {
        handleStructuredContent(result.structuredContent);
      }
      isLoading = false;
      render();
    };

    app.onhostcontextchanged = (ctx) => {
      if (ctx.theme) applyDocumentTheme(ctx.theme);
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    };

    app.onerror = (err) => {
      console.error("MCP App error:", err);
      errorMsg = String(err);
      isLoading = false;
      render();
    };

    function handleStructuredContent(data) {
      if (data.action === "list" && Array.isArray(data.todos)) {
        todos = data.todos;
        if (data.stats) updateStats(data.stats);
        if (data.user_name) userName = data.user_name;
        if (data.user_id) userId = data.user_id;
      } else if (data.action === "created" && data.todo) {
        todos.unshift(data.todo);
      } else if (data.action === "updated" && data.todo) {
        const idx = todos.findIndex(t => t.id === data.todo.id);
        if (idx !== -1) todos[idx] = data.todo;
      } else if (data.action === "toggled" && data.todo) {
        const idx = todos.findIndex(t => t.id === data.todo.id);
        if (idx !== -1) todos[idx] = data.todo;
      } else if (data.action === "deleted" && data.todoId) {
        todos = todos.filter(t => t.id !== data.todoId);
      } else if (data.action === "user_info") {
        userName = data.displayName || "";
      } else if (data.action === "error") {
        errorMsg = data.message || "An error occurred";
      }
      if (data.stats) updateStats(data.stats);
      render();
    }

    let stats = { total: 0, active: 0, completed: 0 };
    function updateStats(s) { stats = s; }

    // ── Server Tool Calls ──
    async function callTool(name, args = {}) {
      isLoading = true;
      errorMsg = "";
      render();
      try {
        const result = await app.callServerTool({ name, arguments: args });
        if (result.structuredContent) {
          handleStructuredContent(result.structuredContent);
        }
      } catch (err) {
        errorMsg = "Failed: " + (err.message || String(err));
        console.error("Tool call error:", err);
      }
      isLoading = false;
      render();
    }

    async function loadTodos() {
      await callTool("list_todos", { filter: currentFilter });
    }

    async function addTodo(title, description) {
      if (!title.trim()) return;
      await callTool("add_todo", { title: title.trim(), description: description?.trim() || "" });
    }

    async function toggleTodo(todoId) {
      await callTool("toggle_todo", { todo_id: todoId });
    }

    async function deleteTodo(todoId) {
      await callTool("delete_todo", { todo_id: todoId });
    }

    async function editTodo(todoId, title, description) {
      await callTool("edit_todo", { todo_id: todoId, title, description: description || "" });
      editingId = null;
    }

    // ── Rendering ──
    function render() {
      const el = document.getElementById("app");

      if (!userId && !userName) {
        el.innerHTML = renderAuthRequired();
        return;
      }

      el.innerHTML = [
        renderHeader(),
        errorMsg ? '<div class="error-msg">' + escHtml(errorMsg) + '</div>' : '',
        renderAddForm(),
        renderFilterBar(),
        isLoading ? '<div class="loading"><div class="spinner"></div>Loading...</div>' : '',
        renderTodoList(),
      ].join("");

      attachEventListeners();
    }

    function renderAuthRequired() {
      return '<div class="auth-required">' +
        '<h3>🔐 Sign in Required</h3>' +
        '<p>Ask the assistant to list your todos.<br>Authentication will happen automatically via Entra ID.</p>' +
        '</div>';
    }

    function renderHeader() {
      return '<div class="app-header">' +
        '<div class="app-title">' +
          '📋 My Todos' +
          (userName ? ' <span class="user-name">(' + escHtml(userName) + ')</span>' : '') +
        '</div>' +
        '<div class="stats">' +
          '<span class="stat-badge active">' + stats.active + ' active</span>' +
          '<span class="stat-badge done">' + stats.completed + ' done</span>' +
        '</div>' +
      '</div>';
    }

    function renderAddForm() {
      return '<div class="add-form">' +
        '<input type="text" id="new-title" placeholder="What needs to be done?" />' +
        '<input type="text" id="new-desc" placeholder="Description (optional)" style="max-width:160px" />' +
        '<button class="btn btn-primary" id="add-btn">Add</button>' +
      '</div>';
    }

    function renderFilterBar() {
      const filters = ["all", "active", "completed"];
      return '<div class="filter-bar">' +
        filters.map(f =>
          '<button class="filter-btn' + (currentFilter === f ? ' active' : '') +
          '" data-filter="' + f + '">' +
          f.charAt(0).toUpperCase() + f.slice(1) +
          '</button>'
        ).join("") +
      '</div>';
    }

    function renderTodoList() {
      const filtered = currentFilter === "all" ? todos :
        currentFilter === "active" ? todos.filter(t => !t.completed) :
        todos.filter(t => t.completed);

      if (filtered.length === 0 && !isLoading) {
        const msgs = { all: "No todos yet. Add one above!", active: "All done! 🎉", completed: "Nothing completed yet." };
        return '<div class="empty-state">' + msgs[currentFilter] + '</div>';
      }

      return '<ul class="todo-list">' +
        filtered.map(t => editingId === t.id ? renderEditItem(t) : renderTodoItem(t)).join("") +
      '</ul>';
    }

    function renderTodoItem(t) {
      return '<li class="todo-item' + (t.completed ? ' completed' : '') + '" data-id="' + t.id + '">' +
        '<input type="checkbox" class="todo-checkbox" data-toggle="' + t.id + '"' +
          (t.completed ? ' checked' : '') + ' />' +
        '<div class="todo-content">' +
          '<div class="todo-title">' + escHtml(t.title) + '</div>' +
          (t.description ? '<div class="todo-desc">' + escHtml(t.description) + '</div>' : '') +
        '</div>' +
        '<div class="todo-actions">' +
          '<button class="btn-icon" data-edit="' + t.id + '" title="Edit">✏️</button>' +
          '<button class="btn-icon" data-delete="' + t.id + '" title="Delete">🗑️</button>' +
        '</div>' +
      '</li>';
    }

    function renderEditItem(t) {
      return '<li class="todo-item" data-id="' + t.id + '">' +
        '<div class="edit-form">' +
          '<input type="text" id="edit-title-' + t.id + '" value="' + escAttr(t.title) + '" />' +
          '<input type="text" id="edit-desc-' + t.id + '" value="' + escAttr(t.description || '') +
            '" placeholder="Description" />' +
          '<div class="edit-actions">' +
            '<button class="btn btn-primary" data-save="' + t.id + '">Save</button>' +
            '<button class="btn" data-cancel="' + t.id + '">Cancel</button>' +
          '</div>' +
        '</div>' +
      '</li>';
    }

    function attachEventListeners() {
      // Add button
      const addBtn = document.getElementById("add-btn");
      if (addBtn) {
        addBtn.addEventListener("click", () => {
          const title = document.getElementById("new-title")?.value;
          const desc = document.getElementById("new-desc")?.value;
          addTodo(title, desc);
        });
      }

      // Enter key on title input
      const titleInput = document.getElementById("new-title");
      if (titleInput) {
        titleInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            const desc = document.getElementById("new-desc")?.value;
            addTodo(e.target.value, desc);
          }
        });
      }

      // Filter buttons
      document.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          currentFilter = btn.dataset.filter;
          render();
        });
      });

      // Checkboxes (toggle)
      document.querySelectorAll("[data-toggle]").forEach(cb => {
        cb.addEventListener("change", () => toggleTodo(cb.dataset.toggle));
      });

      // Edit buttons
      document.querySelectorAll("[data-edit]").forEach(btn => {
        btn.addEventListener("click", () => {
          editingId = btn.dataset.edit;
          render();
        });
      });

      // Delete buttons
      document.querySelectorAll("[data-delete]").forEach(btn => {
        btn.addEventListener("click", () => deleteTodo(btn.dataset.delete));
      });

      // Save edit
      document.querySelectorAll("[data-save]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.save;
          const title = document.getElementById("edit-title-" + id)?.value;
          const desc = document.getElementById("edit-desc-" + id)?.value;
          if (title?.trim()) editTodo(id, title.trim(), desc?.trim());
        });
      });

      // Cancel edit
      document.querySelectorAll("[data-cancel]").forEach(btn => {
        btn.addEventListener("click", () => {
          editingId = null;
          render();
        });
      });
    }

    function escHtml(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    function escAttr(s) {
      return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
    }

    // ── Boot ──
    app.connect().then(async () => {
      const ctx = app.getHostContext();
      if (ctx?.theme) applyDocumentTheme(ctx.theme);
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);

      // Initial render — show auth-required state until list_todos is called
      render();
    }).catch(err => {
      console.error("Failed to connect MCP App:", err);
      document.getElementById("app").innerHTML =
        '<div class="error-msg">Failed to connect to host: ' + escHtml(err) + '</div>';
    });
  </script>

</body>
</html>`;
}
