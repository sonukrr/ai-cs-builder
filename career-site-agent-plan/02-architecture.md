# Architecture

## High-Level Architecture

```text
Company Admin
    |
    v
Career Site Studio (Next.js)
    |
    v
Career Site Orchestrator Agent
    |
    +-------------------+-------------------+
    |                   |                   |
    v                   v                   v
Figma MCP           GitHub MCP       Optional Research
    |                   |              Tavily/Firecrawl
    +-------------------+-------------------+
                        |
                        v
                Site Planner
                        |
                        +--------------------+
                        |                    |
                        v                    v
             Component Registry       Base Site Context
              zm-careers-lib
                        |
                        v
                 Site Blueprint
                        |
             +----------+-----------+
             |                      |
             v                      v
      Preview Renderer        GitHub Branch
             |                      |
             +----------+-----------+
                        |
                        v
                  Preview URL
                        |
                        v
                 Publish Request
```

## Recommended Stack

### Frontend
- Next.js
- React
- TypeScript

### Agent Orchestration
Choose one:
- Claude Agent SDK (recommended if Claude ecosystem is preferred)
- OpenAI Agents SDK
- Mastra (alternative for TypeScript-first orchestration)

Do not combine multiple orchestration frameworks for the MVP.

### MCP Tools
- Figma MCP
- GitHub MCP

### Optional Tools
- Tavily: web search when external research is explicitly required
- Firecrawl: website content/structure extraction when permitted and needed

### Persistence
- Supabase/PostgreSQL for projects, blueprints, versions and conversations

### Preview
- Vercel preview deployments or an internal preview environment

## Architecture Rule
The agent should modify structured configuration first.

Preferred:

```text
Agent → Site Blueprint → Renderer / Controlled Code Update
```

Avoid:

```text
Agent → Arbitrary React File Changes
```
