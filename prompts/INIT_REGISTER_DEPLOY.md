---
name: manus-code-site-deploy
description: Manage system commands for code directory registration, UI server exposure, and static/dynamic deployments. Use when tasks involve `code add/list/ignore`, `site add/list/ignore`, starting UI dev/prod servers bound to 0.0.0.0, or deploying projects via `static-deploy`/`dynamic-deploy` (including next/flask/express variants) with required summary and app_name args.
---

# Code Site Deploy

## Overview

Register code directories, expose running UI servers, and deploy projects using the command set while keeping payloads minimal.

## Code Directory Registration

- Use `code add <directory> <summary>` to register a project directory for the VSCode-style frontend viewer; record the returned idx.
- Use `code list` to confirm what is registered; present results as `(idx, directory, summary)`.
- Use `code ignore <directory>` or `code ignore <idx>` to remove a directory from the list.
- Mandatory: when the user asks to build an app, write code, or modify code in a repo, add the relevant directory via `code add` before or alongside the change.

## Site Registration (UI Servers)

- Start a dev or prod server whenever you build a frontend or a backend with a UI.
- Bind the server to `0.0.0.0` so the system can expose the port publicly.
- Use `site add <port> <summary> <optional:path>` after the server starts; record the returned idx.
- Use `site list` to confirm exposure; present results as `(idx, port, path, summary)`.
- Use `site ignore <idx>` to stop tracking an exposed site.
- Mandatory: when the user asks to run servers or you start a UI server as part of fulfilling a request, register it with `site add`.

## Deployment Workflow

Deployment is optional and only performed when the user explicitly asks to deploy.

### 1) Decide static vs dynamic

- Use **static deploy** when there is no backend and the site can be served as static files (e.g., React build output).
- Use **dynamic deploy** when a backend/server runtime is required (e.g., Express, Next.js, Flask).

### 2) Minimize directory size

- Include only what is necessary to run.
- Exclude caches, tests, local artifacts, and large assets that are not required.
- For **dynamic** deployments, include runtime dependencies (for Node backends, include `node_modules` to avoid remote installs).
- For **static** deployments, exclude `node_modules`; build production artifacts locally and deploy only the build output plus required config/static files.

### 3) Run the deploy command (summary + app name required)

- Static:
  - Build production assets first.
  - Run `static-deploy new <directory> <summary> <app_name> --ignore [...directory]`.
  - Expect `(idx, url)` in response.
- Dynamic:
  - Choose `dynamic-deploy new` or a framework-specific variant (`new-next`, `new-flask`, `new-express`).
  - Run `dynamic-deploy new <directory> <summary> <app_name> --ignore [...directory] --setup [..setup_commands] --startup <startup command>`.
  - Supply `--setup` commands as needed and a `--startup` command that launches the server bound to `0.0.0.0`.
  - Expect `(idx, log, url)` or `(idx, url)` in response.
  - For `new-next`/`new-flask`/`new-express`, keep the same `<directory> <summary> <app_name>` argument order.

### 4) Follow-up operations

- Use `static-deploy list` to view recent deployments as `(idx, time, summary, app_name, url)`.
- Use `dynamic-deploy list` to view recent deployments as `(idx, time, summary, app_name)`.
- Use `static-deploy rollback <idx>` or `dynamic-deploy rollback <idx>` to revert.
- Use `dynamic-deploy log <idx>` to inspect a dynamic deployment.

## Examples

```bash
# Register a code directory for the editor viewer
code add /home/shou/tintin "Main Tintin repo"

# Stop tracking a directory
code ignore /home/shou/tintin

# Start a UI server (must listen on 0.0.0.0) and expose it
npm run dev -- --host 0.0.0.0 --port 5173
site add 5173 "Vite dev server"

# Static deploy (React build output)
npm run build
static-deploy new /home/shou/tintin/dist "Marketing site build" "tintin-marketing" --ignore [/home/shou/tintin/node_modules]

# Dynamic deploy (Express API + UI)
dynamic-deploy new /home/shou/tintin "Admin console" "tintin-admin" --ignore [/home/shou/tintin/.git] --setup ["npm ci"] --startup "npm run start -- --host 0.0.0.0 --port 3000"

# Dynamic deploy (Next.js)
dynamic-deploy new-next /home/shou/tintin "Next dashboard" "tintin-dashboard" --ignore [/home/shou/tintin/.git] --setup ["npm ci"] --startup "npm run start -- --hostname 0.0.0.0 --port 3000"

