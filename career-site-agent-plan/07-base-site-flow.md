# Start From Base Flow

## Objective
Allow company administrators to start with an approved default career site and customize it.

## Source
A controlled GitHub repository.

Example:

```text
career-site-base/
├── app/
├── components/
├── config/
│   ├── site.json
│   ├── theme.json
│   └── content.json
└── README.md
```

## GitHub MCP Responsibilities

The agent may:
- Read repository structure
- Read documentation
- Discover pages
- Discover reusable components
- Read configuration
- Create a company-specific branch
- Commit controlled changes

The agent must not:
- Modify the protected main branch directly
- Modify production infrastructure
- Arbitrarily rewrite core architecture

## Customization Flow

```text
Admin selects Start From Base
→ Agent reads repository context
→ Agent asks for company/brand requirements
→ Agent proposes customization plan
→ Admin approves
→ Blueprint updated
→ Controlled code/config generated
→ Branch created
→ Preview deployed
```

## Preferred Customization Targets

Prioritize:

```text
site.config.json
theme.json
content.json
```

before modifying arbitrary React source files.
