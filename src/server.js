const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { db, statements } = require("./db");

const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    }
  })
);

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function render(res, view, options = {}) {
  return res.render(view, {
    pageTitle: "Project Pulse",
    currentUser: res.locals.currentUser,
    flash: res.locals.flash,
    ...options
  });
}

app.use((req, res, next) => {
  const userId = req.session.userId;
  res.locals.currentUser = userId ? statements.findUserById.get(userId) : null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

function requireAuth(req, res, next) {
  if (!res.locals.currentUser) {
    setFlash(req, "error", "Please log in to continue.");
    return res.redirect("/login");
  }
  next();
}

function requireProjectMembership(req, res, next) {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) {
    return res.status(404).send("Project not found");
  }

  const membership = statements.getProjectMembership.get(projectId, res.locals.currentUser.id);
  if (!membership) {
    return res.status(403).send("You do not have access to this project.");
  }

  req.project = membership;
  next();
}

function requireProjectAdmin(req, res, next) {
  if (req.project.role !== "admin") {
    return res.status(403).send("Admin access required.");
  }
  next();
}

function normalizeTask(task) {
  return {
    ...task,
    isOverdue: Boolean(task.due_date && task.due_date < new Date().toISOString().slice(0, 10) && task.status !== "done")
  };
}

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

app.get("/", (req, res) => {
  if (res.locals.currentUser) {
    return res.redirect("/dashboard");
  }

  return render(res, "home", { pageTitle: "Project Pulse | Team Task Tracking" });
});

app.get("/signup", (req, res) => render(res, "auth/signup", { pageTitle: "Sign Up | Project Pulse" }));
app.get("/login", (req, res) => render(res, "auth/login", { pageTitle: "Login | Project Pulse" }));

function signupUser(payload) {
  const name = trim(payload.name);
  const email = trim(payload.email).toLowerCase();
  const password = payload.password || "";

  if (name.length < 2) {
    return { error: "Name must be at least 2 characters." };
  }
  if (!validateEmail(email)) {
    return { error: "Enter a valid email address." };
  }
  if (password.length < 6) {
    return { error: "Password must be at least 6 characters." };
  }
  if (statements.findUserByEmail.get(email)) {
    return { error: "An account with that email already exists." };
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const result = statements.createUser.run({ name, email, password_hash });
  return { userId: result.lastInsertRowid };
}

app.post("/signup", (req, res) => {
  const result = signupUser(req.body);
  if (result.error) {
    setFlash(req, "error", result.error);
    return res.redirect("/signup");
  }
  req.session.userId = Number(result.userId);
  setFlash(req, "success", "Account created successfully.");
  return res.redirect("/dashboard");
});

app.post("/api/auth/signup", (req, res) => {
  const result = signupUser(req.body);
  if (result.error) {
    return jsonError(res, 400, result.error);
  }
  return res.status(201).json({ id: Number(result.userId) });
});

function loginUser(payload) {
  const email = trim(payload.email).toLowerCase();
  const password = payload.password || "";
  const user = statements.findUserByEmail.get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return { error: "Invalid email or password." };
  }
  return { userId: user.id };
}

app.post("/login", (req, res) => {
  const result = loginUser(req.body);
  if (result.error) {
    setFlash(req, "error", result.error);
    return res.redirect("/login");
  }
  req.session.userId = result.userId;
  setFlash(req, "success", "Welcome back.");
  return res.redirect("/dashboard");
});

app.post("/api/auth/login", (req, res) => {
  const result = loginUser(req.body);
  if (result.error) {
    return jsonError(res, 401, result.error);
  }
  req.session.userId = result.userId;
  return res.json({ id: result.userId });
});

app.post("/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

app.get("/dashboard", requireAuth, (req, res) => {
  const stats = statements.dashboardStats.get(res.locals.currentUser.id);
  const tasks = statements.dashboardTasks.all(res.locals.currentUser.id).map(normalizeTask);
  const projects = statements.listProjectsForUser.all(res.locals.currentUser.id);

  return render(res, "dashboard", {
    pageTitle: "Dashboard | Project Pulse",
    stats,
    tasks,
    projects
  });
});

function createProject(userId, payload) {
  const name = trim(payload.name);
  const description = trim(payload.description);

  if (name.length < 3) {
    return { error: "Project name must be at least 3 characters." };
  }

  const tx = db.transaction(() => {
    const result = statements.createProject.run({ name, description, owner_id: userId });
    const projectId = Number(result.lastInsertRowid);
    statements.addProjectMember.run({ project_id: projectId, user_id: userId, role: "admin" });
    return projectId;
  });

  return { projectId: tx() };
}

app.get("/projects", requireAuth, (req, res) => {
  const projects = statements.listProjectsForUser.all(res.locals.currentUser.id);
  return render(res, "projects/index", {
    pageTitle: "Projects | Project Pulse",
    projects
  });
});

app.post("/projects", requireAuth, (req, res) => {
  const result = createProject(res.locals.currentUser.id, req.body);
  if (result.error) {
    setFlash(req, "error", result.error);
    return res.redirect("/projects");
  }
  setFlash(req, "success", "Project created.");
  return res.redirect(`/projects/${result.projectId}`);
});

app.get("/api/projects", requireAuth, (req, res) => {
  return res.json(statements.listProjectsForUser.all(res.locals.currentUser.id));
});

app.post("/api/projects", requireAuth, (req, res) => {
  const result = createProject(res.locals.currentUser.id, req.body);
  if (result.error) {
    return jsonError(res, 400, result.error);
  }
  return res.status(201).json({ id: result.projectId });
});

app.get("/projects/:projectId", requireAuth, requireProjectMembership, (req, res) => {
  const members = statements.listProjectMembers.all(req.project.id);
  const tasks = statements.listTasksByProject.all(req.project.id).map(normalizeTask);

  return render(res, "projects/show", {
    pageTitle: `${req.project.name} | Project Pulse`,
    project: req.project,
    members,
    tasks
  });
});

app.get("/api/projects/:projectId", requireAuth, requireProjectMembership, (req, res) => {
  const project = statements.getProjectById.get(req.project.id);
  const members = statements.listProjectMembers.all(req.project.id);
  const tasks = statements.listTasksByProject.all(req.project.id).map(normalizeTask);
  return res.json({ project, role: req.project.role, members, tasks });
});

function addMember(projectId, payload) {
  const email = trim(payload.email).toLowerCase();
  const role = payload.role === "admin" ? "admin" : "member";

  if (!validateEmail(email)) {
    return { error: "Enter a valid email address." };
  }

  const user = statements.findUserForProjectInvite.get(email);
  if (!user) {
    return { error: "User not found. Ask them to sign up first." };
  }

  statements.addProjectMember.run({ project_id: projectId, user_id: user.id, role });
  return { memberId: user.id };
}

app.post("/projects/:projectId/members", requireAuth, requireProjectMembership, requireProjectAdmin, (req, res) => {
  const result = addMember(req.project.id, req.body);
  if (result.error) {
    setFlash(req, "error", result.error);
  } else {
    setFlash(req, "success", "Team member added.");
  }
  return res.redirect(`/projects/${req.project.id}`);
});

app.post("/api/projects/:projectId/members", requireAuth, requireProjectMembership, requireProjectAdmin, (req, res) => {
  const result = addMember(req.project.id, req.body);
  if (result.error) {
    return jsonError(res, 400, result.error);
  }
  return res.status(201).json({ id: result.memberId });
});

function createTask(projectId, currentUserId, payload) {
  const title = trim(payload.title);
  const description = trim(payload.description);
  const status = ["todo", "in_progress", "done"].includes(payload.status) ? payload.status : "todo";
  const assignee_id = payload.assignee_id ? Number(payload.assignee_id) : null;
  const due_date = trim(payload.due_date) || null;

  if (title.length < 3) {
    return { error: "Task title must be at least 3 characters." };
  }
  if (assignee_id && !statements.listProjectMembers.all(projectId).some((member) => member.id === assignee_id)) {
    return { error: "Assignee must belong to the project." };
  }
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return { error: "Due date must be in YYYY-MM-DD format." };
  }

  const result = statements.createTask.run({
    project_id: projectId,
    title,
    description,
    status,
    assignee_id,
    due_date,
    created_by: currentUserId
  });
  return { taskId: Number(result.lastInsertRowid) };
}

app.post("/projects/:projectId/tasks", requireAuth, requireProjectMembership, (req, res) => {
  const result = createTask(req.project.id, res.locals.currentUser.id, req.body);
  if (result.error) {
    setFlash(req, "error", result.error);
  } else {
    setFlash(req, "success", "Task created.");
  }
  return res.redirect(`/projects/${req.project.id}`);
});

app.post("/api/projects/:projectId/tasks", requireAuth, requireProjectMembership, (req, res) => {
  const result = createTask(req.project.id, res.locals.currentUser.id, req.body);
  if (result.error) {
    return jsonError(res, 400, result.error);
  }
  return res.status(201).json({ id: result.taskId });
});

function getTaskAccess(taskId, userId) {
  return statements.getTaskWithMembership.get(taskId, userId);
}

app.post("/tasks/:taskId/status", requireAuth, (req, res) => {
  const taskId = Number(req.params.taskId);
  const access = getTaskAccess(taskId, res.locals.currentUser.id);
  if (!access) {
    return res.status(403).send("Task not accessible.");
  }
  const status = ["todo", "in_progress", "done"].includes(req.body.status) ? req.body.status : null;
  if (!status) {
    setFlash(req, "error", "Invalid task status.");
    return res.redirect(`/projects/${access.project_id}`);
  }
  statements.updateTaskStatus.run({ id: taskId, status });
  setFlash(req, "success", "Task status updated.");
  return res.redirect(`/projects/${access.project_id}`);
});

app.patch("/api/tasks/:taskId", requireAuth, (req, res) => {
  const taskId = Number(req.params.taskId);
  const access = getTaskAccess(taskId, res.locals.currentUser.id);
  if (!access) {
    return jsonError(res, 403, "Task not accessible.");
  }

  if (req.body.status) {
    if (!["todo", "in_progress", "done"].includes(req.body.status)) {
      return jsonError(res, 400, "Invalid task status.");
    }
    statements.updateTaskStatus.run({ id: taskId, status: req.body.status });
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "assignee_id")) {
    if (access.role !== "admin") {
      return jsonError(res, 403, "Only project admins can reassign tasks.");
    }
    const assigneeId = req.body.assignee_id ? Number(req.body.assignee_id) : null;
    const validMember = !assigneeId || statements.listProjectMembers.all(access.project_id).some((member) => member.id === assigneeId);
    if (!validMember) {
      return jsonError(res, 400, "Assignee must belong to the project.");
    }
    statements.updateTaskAssignment.run({ id: taskId, assignee_id: assigneeId });
  }

  return res.json({ ok: true });
});

app.post("/tasks/:taskId/assign", requireAuth, (req, res) => {
  const taskId = Number(req.params.taskId);
  const access = getTaskAccess(taskId, res.locals.currentUser.id);
  if (!access || access.role !== "admin") {
    return res.status(403).send("Admin access required.");
  }
  const assigneeId = req.body.assignee_id ? Number(req.body.assignee_id) : null;
  const validMember = !assigneeId || statements.listProjectMembers.all(access.project_id).some((member) => member.id === assigneeId);
  if (!validMember) {
    setFlash(req, "error", "Assignee must belong to the project.");
    return res.redirect(`/projects/${access.project_id}`);
  }
  statements.updateTaskAssignment.run({ id: taskId, assignee_id: assigneeId });
  setFlash(req, "success", "Task assignment updated.");
  return res.redirect(`/projects/${access.project_id}`);
});

app.use((req, res) => {
  res.status(404);
  return render(res, "404", { pageTitle: "Not Found | Project Pulse" });
});

app.listen(port, () => {
  console.log(`Project Pulse listening on http://localhost:${port}`);
});
