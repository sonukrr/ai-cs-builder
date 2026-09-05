# Site Blueprint

## Purpose
The Site Blueprint is the central source of truth for every career site.

Both entry points must eventually produce the same blueprint.

```text
Figma → Blueprint
Base Site → Blueprint
Conversation → Blueprint Update
```

## Initial Schema

```json
{
  "projectId": "company-project-id",
  "company": {
    "name": "Acme",
    "brand": {
      "logo": "",
      "colors": {
        "primary": "#000000",
        "secondary": "#FFFFFF"
      },
      "fonts": []
    }
  },
  "pages": [
    {
      "id": "home",
      "name": "Home",
      "path": "/",
      "sections": [
        {
          "id": "hero-1",
          "type": "hero",
          "category": "static",
          "source": "base",
          "props": {}
        },
        {
          "id": "job-search-1",
          "type": "job-search",
          "category": "functional",
          "source": "zm-careers-lib",
          "props": {}
        }
      ]
    }
  ],
  "version": 1
}
```

## Blueprint Operations

The agent must support:

- Add page
- Remove page
- Add section
- Remove section
- Reorder sections
- Update section props
- Change theme
- Add approved functional component
- Update content
- Create version

## Validation

Before rendering:
- Page IDs must be unique
- Section IDs must be unique
- Functional components must exist in the approved registry
- Props must satisfy component definitions
- Navigation targets must exist
