import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Счета пользователя: наличные, карты, вклады, инвестиции, прочее.
 * opening_balance + сумма операций = текущий баланс (вычисляется на лету).
 */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ["cash", "card", "deposit", "investment", "other"] }).notNull(),
  currency: text("currency").notNull().default("RUB"),
  openingBalance: real("opening_balance").notNull().default(0),
  openingDate: text("opening_date").notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  providerId: text("provider_id"),
  externalId: text("external_id"),
  createdAt: text("created_at").notNull(),
});

/**
 * Категории операций: иерархия max 2 уровня (parent_id ссылается на categories.id).
 */
export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  name: text("name").notNull(),
  icon: text("icon"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
});

/**
 * Операции: расход < 0, доход > 0. Идемпотентность импорта по
 * (account_id, source, external_id).
 */
export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    date: text("date").notNull(),
    amount: real("amount").notNull(),
    currency: text("currency").notNull().default("RUB"),
    description: text("description").notNull(),
    merchant: text("merchant"),
    categoryId: text("category_id"),
    source: text("source").notNull(),
    externalId: text("external_id"),
    importedAt: text("imported_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    importKey: uniqueIndex("operations_import_key").on(
      table.accountId,
      table.source,
      table.externalId,
    ),
    byAccountDate: uniqueIndex("operations_account_date").on(
      table.accountId,
      table.date,
      table.id,
    ),
  }),
);

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color"),
});

export const operationTags = sqliteTable(
  "operation_tags",
  {
    operationId: text("operation_id").notNull(),
    tagId: text("tag_id").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.operationId, table.tagId] }),
  }),
);

/**
 * Подключения к банковским провайдерам (CSV/OFX не требуют подключения,
 * но для будущих Salt Edge/Enable Banking).
 */
export const providerConnections = sqliteTable("provider_connections", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  accountId: text("account_id"),
  status: text("status", {
    enum: ["active", "expired", "revoked", "error"],
  }).notNull(),
  configJson: text("config_json").notNull().default("{}"),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
});

/**
 * Материализованный net worth по счетам (опционально для скорости).
 */
export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    date: text("date").notNull(),
    amount: real("amount").notNull(),
  },
  (table) => ({
    uniq: uniqueIndex("balance_snapshots_account_date").on(
      table.accountId,
      table.date,
    ),
  }),
);

/**
 * Пользователи (для MVP — один владелец, но таблица готова к расширению).
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type Operation = typeof operations.$inferSelect;
export type Category = typeof categories.$inferSelect;