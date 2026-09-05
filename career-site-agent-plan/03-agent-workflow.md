# Agent Workflow

## Agent Model

Start with a single orchestrator agent and tools.

Do not create many autonomous agents for the MVP.

The orchestrator decides which tool or workflow to use.

## Primary Intents

### 1. IMPORT_FIGMA
Triggered when the user wants to import an existing design.

Flow:

```text
User selects Import Figma
→ Figma MCP
→ Extract design structure
→ Semantic section analysis
→ Component mapping
→ Generate Site Blueprint
→ Present AI Site Plan
→ User approval
→ Generate preview
```

### 2. START_FROM_BASE
Triggered when the user starts from the default career site.

Flow:

```text
User selects Start From Base
→ GitHub MCP reads approved repository
→ Discover pages/components/configuration
→ Collect company requirements
→ Customize Site Blueprint
→ Present AI Site Plan
→ User approval
→ Generate preview
```

### 3. MODIFY_SITE
Triggered by conversational or visual editing.

Example:
"Move Job Search above Employee Stories."

Flow:

```text
User request
→ Identify selected/current page and section context
→ Read current Site Blueprint
→ Determine affected sections
→ Validate capability
→ Update Blueprint
→ Generate change summary
→ Refresh preview
→ Save version
```

### 4. ADD_FUNCTIONALITY
Example:
"Add resume upload."

Flow:

```text
Requirement
→ Search Component Registry
→ Find approved zm-careers-lib component
→ Validate supported props/configuration
→ Update Site Blueprint
→ Preview
```

### 5. RESEARCH_OR_INSPIRATION
Only use when the user explicitly requests external inspiration or research.

Example:
"Take inspiration from Rakuten's careers site."

Flow:

```text
Request
→ Search / research tool
→ Extract high-level design patterns
→ Summarize patterns
→ Create original implementation plan
```

Do not copy source code or copyrighted content.

## Agent Rules

1. Prefer internal components before generating new functionality.
2. Prefer base-site components before creating new static components.
3. Never invent unsupported functional capabilities.
4. Ask for clarification when a requirement materially affects functionality.
5. Present significant changes before applying them.
6. Persist every approved change as a version.
7. Never modify production directly.
