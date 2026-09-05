# Instructions for Claude Code

## Objective
Implement the Career Site Builder Agent MVP described in this repository.

## First Action
Before writing significant implementation code:

1. Read every markdown file in this directory.
2. Inspect the existing application repository.
3. Identify the current framework and project structure.
4. Produce a concise implementation plan.
5. Ask for clarification only if a required integration credential or repository location is unavailable.

## Architecture Requirements

- Use TypeScript.
- Keep the frontend and agent interfaces modular.
- Use one primary agent orchestrator for the MVP.
- Treat MCP servers as tools.
- Keep Site Blueprint as the source of truth.
- Use structured schemas and validation.
- Do not allow arbitrary AI edits to protected production code.
- Prefer configuration changes over source-code changes.
- Use approved functional components from the Component Registry.

## Entry Points

Implement:

### `/projects/new`
Starting point selection:
- Import Existing Figma
- Start From Base

### `/studio/[projectId]`
Three-panel Career Site Studio:
- Site Structure
- AI Assistant
- Live Preview

## Required Backend / Agent Capabilities

### Intent Router
Supported intents:
- IMPORT_FIGMA
- START_FROM_BASE
- MODIFY_SITE
- ADD_FUNCTIONALITY
- RESEARCH_OR_INSPIRATION
- REQUEST_PUBLISH

### Core Operations
- Read Figma through MCP
- Read base site through GitHub MCP
- Search component registry
- Generate Site Blueprint
- Validate Site Blueprint
- Apply structured modifications
- Create version history

## Development Strategy

Build incrementally.

### Milestone 1
Render a hardcoded Site Blueprint.

### Milestone 2
Make the blueprint editable through UI actions.

### Milestone 3
Add conversational modifications.

### Milestone 4
Connect GitHub MCP.

### Milestone 5
Connect Figma MCP.

Do not block early UI development waiting for MCP credentials.

Use adapters/interfaces and mocked providers initially.

## Important Safety / Governance

The AI must:
- Never deploy directly to production.
- Never expose internal source repositories to company administrators.
- Never claim unsupported functionality exists.
- Never bypass component validation.
- Never modify protected branches directly.

## Definition of Done for MVP

A demo should support:

1. Admin chooses Start From Base.
2. Agent loads a base career site.
3. Admin requests:
   "Make this site focused on engineering careers and add employee stories."
4. Agent updates the Site Blueprint.
5. Agent maps Job Search to an approved functional component.
6. Preview updates.
7. Change summary appears.
8. Version is saved.

Additionally, demonstrate:

1. Admin imports a Figma design.
2. Agent detects sections.
3. Agent maps at least one functional component.
4. Agent presents an AI Site Plan.
5. Admin approves the plan.
6. Preview is generated.
