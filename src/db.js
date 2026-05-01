const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, "app.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')) DEFAULT 'todo',
    assignee_id INTEGER,
    due_date TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
`);

const statements = {
  createUser: db.prepare(`
    INSERT INTO users (name, email, password_hash)
    VALUES (@name, @email, @password_hash)
  `),
  findUserByEmail: db.prepare(`
    SELECT id, name, email, password_hash
    FROM users
    WHERE email = ?
  `),
  findUserById: db.prepare(`
    SELECT id, name, email, created_at
    FROM users
    WHERE id = ?
  `),
  createProject: db.prepare(`
    INSERT INTO projects (name, description, owner_id)
    VALUES (@name, @description, @owner_id)
  `),
  addProjectMember: db.prepare(`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (@project_id, @user_id, @role)
    ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role
  `),
  getProjectMembership: db.prepare(`
    SELECT p.id, p.name, p.description, p.owner_id, pm.role
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id
    WHERE p.id = ? AND pm.user_id = ?
  `),
  getProjectById: db.prepare(`
    SELECT id, name, description, owner_id, created_at
    FROM projects
    WHERE id = ?
  `),
  listProjectsForUser: db.prepare(`
    SELECT p.id, p.name, p.description, pm.role, p.created_at,
      COUNT(DISTINCT t.id) AS total_tasks,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_tasks
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE pm.user_id = ?
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `),
  listProjectMembers: db.prepare(`
    SELECT u.id, u.name, u.email, pm.role
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ?
    ORDER BY CASE pm.role WHEN 'admin' THEN 0 ELSE 1 END, u.name
  `),
  listTasksByProject: db.prepare(`
    SELECT t.id, t.title, t.description, t.status, t.due_date, t.created_at,
      a.id AS assignee_id, a.name AS assignee_name, a.email AS assignee_email,
      c.name AS creator_name
    FROM tasks t
    LEFT JOIN users a ON a.id = t.assignee_id
    JOIN users c ON c.id = t.created_by
    WHERE t.project_id = ?
    ORDER BY
      CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
      COALESCE(t.due_date, '9999-12-31') ASC,
      t.created_at DESC
  `),
  createTask: db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, assignee_id, due_date, created_by)
    VALUES (@project_id, @title, @description, @status, @assignee_id, @due_date, @created_by)
  `),
  getTaskWithMembership: db.prepare(`
    SELECT t.id, t.project_id, t.assignee_id, pm.role
    FROM tasks t
    JOIN project_members pm ON pm.project_id = t.project_id
    WHERE t.id = ? AND pm.user_id = ?
  `),
  updateTaskStatus: db.prepare(`
    UPDATE tasks
    SET status = @status, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `),
  updateTaskAssignment: db.prepare(`
    UPDATE tasks
    SET assignee_id = @assignee_id, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `),
  dashboardStats: db.prepare(`
    SELECT
      COUNT(*) AS total_tasks,
      SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo_tasks,
      SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_tasks,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_tasks,
      SUM(CASE WHEN t.due_date IS NOT NULL AND t.due_date < date('now') AND t.status != 'done' THEN 1 ELSE 0 END) AS overdue_tasks
    FROM tasks t
    JOIN project_members pm ON pm.project_id = t.project_id
    WHERE pm.user_id = ?
  `),
  dashboardTasks: db.prepare(`
    SELECT t.id, t.title, t.status, t.due_date, p.name AS project_name, p.id AS project_id
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN project_members pm ON pm.project_id = t.project_id
    WHERE pm.user_id = ?
    ORDER BY
      CASE
        WHEN t.due_date IS NOT NULL AND t.due_date < date('now') AND t.status != 'done' THEN 0
        WHEN t.status = 'in_progress' THEN 1
        WHEN t.status = 'todo' THEN 2
        ELSE 3
      END,
      COALESCE(t.due_date, '9999-12-31') ASC
    LIMIT 8
  `),
  findUserForProjectInvite: db.prepare(`
    SELECT id, name, email
    FROM users
    WHERE lower(email) = lower(?)
  `)
};

module.exports = { db, statements };
