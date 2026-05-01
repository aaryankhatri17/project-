# Project Pulse

Project Pulse is a lightweight project management web app where users can create projects, add team members, assign tasks, and track progress with role-based access control.

## Features

- Signup and login with password hashing
- Project creation and team management
- Project-level roles: `admin` and `member`
- Task creation, assignment, status updates, and due dates
- Dashboard with task counts, overdue tracking, and project summaries
- REST APIs for auth, projects, members, and task updates
- Railway-ready deployment config

## Tech Stack

- Node.js
- Express
- EJS
- SQLite via `better-sqlite3`
- Session-based authentication

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

Create a `.env` or set these in Railway:

```bash
PORT=3000
SESSION_SECRET=replace-with-a-secure-random-string
```

## REST API Overview

### Auth

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`

### Projects

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`
- `POST /api/projects/:projectId/members`
- `POST /api/projects/:projectId/tasks`

### Tasks

- `PATCH /api/tasks/:taskId`

Example `PATCH /api/tasks/:taskId` body:

```json
{
  "status": "in_progress",
  "assignee_id": 2
}
```

## Role-Based Access

- Project creators become `admin`
- `admin` users can add members and reassign tasks
- `member` users can view project data and update task status
- Only project members can access a project and its tasks

## Railway Deployment

1. Push this project to GitHub.
2. Create a new Railway project and deploy from the GitHub repo.
3. Add the environment variable `SESSION_SECRET`.
4. Railway will detect `railway.json` and run `npm start`.
5. After deployment, open the generated public URL.

Note: this app stores SQLite data in `data/app.db`. For a production-grade Railway deployment, attach a persistent volume so data survives redeploys.

## Submission Checklist

- Live URL: add after Railway deployment
- GitHub repo: add after pushing
- README: included
- Demo video: record a 2-5 minute walkthrough showing signup, project creation, member invite, task assignment, and status updates
