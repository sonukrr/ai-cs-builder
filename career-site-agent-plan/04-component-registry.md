# Component Registry

## Purpose
Provide the agent with a reliable machine-readable catalog of approved functional components from `zm-careers-lib`.

The agent should not rely only on an npm package URL.

## Recommended Registry Format

```json
{
  "id": "job-search",
  "name": "Job Search",
  "category": "functional",
  "package": "zm-careers-lib",
  "description": "Allows candidates to search for available jobs.",
  "capabilities": [
    "keyword-search",
    "location-search"
  ],
  "props": {},
  "exampleUsage": "",
  "status": "approved"
}
```

## Registry Categories

### Functional
Examples:
- Job Search
- Job Listing
- Job Details
- Apply
- Resume Upload
- Filters
- Pagination

### Static / Presentation
Examples:
- Hero
- Benefits
- Testimonials
- Culture
- Employee Stories
- CTA
- Footer

## Component Selection Rules

```text
User Requirement
      |
      v
Search approved registry
      |
      +-- Match Found → Configure approved component
      |
      +-- No Match → Check base site reusable component
      |
      +-- No Match → Mark as custom static component or unsupported functionality
```

## Important UX Requirement
Company administrators should see friendly capability names, not internal React component names.
