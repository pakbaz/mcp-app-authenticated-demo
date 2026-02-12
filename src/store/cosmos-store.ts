import { CosmosClient, Container, Database } from "@azure/cosmos";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import crypto from "node:crypto";

export interface TodoItem {
  id: string;
  user_id: string;
  title: string;
  description: string;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

export type TodoFilter = "all" | "active" | "completed";

export class TodoStore {
  private client: CosmosClient;
  private databaseId: string;
  private containerId: string;
  private database?: Database;
  private container?: Container;
  private initialized = false;

  constructor() {
    const endpoint = process.env.AZURE_COSMOSDB_ENDPOINT;
    this.databaseId = process.env.AZURE_COSMOSDB_DATABASE || "todo-database";
    this.containerId = process.env.AZURE_COSMOSDB_CONTAINER || "todos";

    if (!endpoint) {
      // Use in-memory fallback for local dev without Cosmos DB
      console.warn("AZURE_COSMOSDB_ENDPOINT not set — using in-memory store");
      this.client = null as unknown as CosmosClient;
      return;
    }

    const isProduction = process.env.RUNNING_IN_PRODUCTION === "true";
    const credential = isProduction
      ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
      : new DefaultAzureCredential();

    this.client = new CosmosClient({ endpoint, aadCredentials: credential });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.client) {
      this.initialized = true;
      return;
    }

    const { database } = await this.client.databases.createIfNotExists({
      id: this.databaseId,
    });
    this.database = database;

    const { container } = await database.containers.createIfNotExists({
      id: this.containerId,
      partitionKey: { paths: ["/user_id"] },
    });
    this.container = container;
    this.initialized = true;
  }

  // ── In-memory fallback store ──────────────────────────────────────────
  private inMemoryStore: Map<string, TodoItem[]> = new Map();

  private getUserTodos(userId: string): TodoItem[] {
    if (!this.inMemoryStore.has(userId)) {
      this.inMemoryStore.set(userId, []);
    }
    return this.inMemoryStore.get(userId)!;
  }

  // ── CRUD Operations ──────────────────────────────────────────────────

  async listTodos(userId: string, filter: TodoFilter = "all"): Promise<TodoItem[]> {
    await this.ensureInitialized();

    if (!this.container) {
      const todos = this.getUserTodos(userId);
      if (filter === "active") return todos.filter((t) => !t.completed);
      if (filter === "completed") return todos.filter((t) => t.completed);
      return [...todos];
    }

    let query = "SELECT * FROM c WHERE c.user_id = @userId";
    const params: { name: string; value: string | boolean }[] = [
      { name: "@userId", value: userId },
    ];

    if (filter === "active") {
      query += " AND c.completed = @completed";
      params.push({ name: "@completed", value: false });
    } else if (filter === "completed") {
      query += " AND c.completed = @completed";
      params.push({ name: "@completed", value: true });
    }

    query += " ORDER BY c.created_at DESC";

    const { resources } = await this.container.items
      .query<TodoItem>({ query, parameters: params })
      .fetchAll();
    return resources;
  }

  async createTodo(
    userId: string,
    title: string,
    description: string = ""
  ): Promise<TodoItem> {
    await this.ensureInitialized();

    const now = new Date().toISOString();
    const todo: TodoItem = {
      id: crypto.randomUUID(),
      user_id: userId,
      title,
      description,
      completed: false,
      created_at: now,
      updated_at: now,
    };

    if (!this.container) {
      this.getUserTodos(userId).unshift(todo);
      return todo;
    }

    const { resource } = await this.container.items.create(todo);
    return resource as TodoItem;
  }

  async updateTodo(
    userId: string,
    todoId: string,
    updates: { title?: string; description?: string }
  ): Promise<TodoItem | null> {
    await this.ensureInitialized();

    if (!this.container) {
      const todos = this.getUserTodos(userId);
      const idx = todos.findIndex((t) => t.id === todoId);
      if (idx === -1) return null;
      if (updates.title !== undefined) todos[idx].title = updates.title;
      if (updates.description !== undefined) todos[idx].description = updates.description;
      todos[idx].updated_at = new Date().toISOString();
      return todos[idx];
    }

    const { resource: existing } = await this.container
      .item(todoId, userId)
      .read<TodoItem>();
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
    };
    const { resource } = await this.container
      .item(todoId, userId)
      .replace(updated);
    return resource as TodoItem;
  }

  async toggleTodo(userId: string, todoId: string): Promise<TodoItem | null> {
    await this.ensureInitialized();

    if (!this.container) {
      const todos = this.getUserTodos(userId);
      const idx = todos.findIndex((t) => t.id === todoId);
      if (idx === -1) return null;
      todos[idx].completed = !todos[idx].completed;
      todos[idx].updated_at = new Date().toISOString();
      return todos[idx];
    }

    const { resource: existing } = await this.container
      .item(todoId, userId)
      .read<TodoItem>();
    if (!existing) return null;

    const updated = {
      ...existing,
      completed: !existing.completed,
      updated_at: new Date().toISOString(),
    };
    const { resource } = await this.container
      .item(todoId, userId)
      .replace(updated);
    return resource as TodoItem;
  }

  async deleteTodo(userId: string, todoId: string): Promise<boolean> {
    await this.ensureInitialized();

    if (!this.container) {
      const todos = this.getUserTodos(userId);
      const idx = todos.findIndex((t) => t.id === todoId);
      if (idx === -1) return false;
      todos.splice(idx, 1);
      return true;
    }

    try {
      await this.container.item(todoId, userId).delete();
      return true;
    } catch {
      return false;
    }
  }

  async getStats(userId: string): Promise<{ total: number; active: number; completed: number }> {
    const all = await this.listTodos(userId, "all");
    const completed = all.filter((t) => t.completed).length;
    return {
      total: all.length,
      active: all.length - completed,
      completed,
    };
  }
}
