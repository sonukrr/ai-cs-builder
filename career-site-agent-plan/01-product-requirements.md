# Product Requirements

## Problem
Creating and maintaining customized career sites requires repeated interaction between company administrators and development teams.

Companies provide designs, branding, page requirements, and content. Developers then interpret those requirements and implement supported functional capabilities.

Even small changes can require tickets, development effort, QA, and deployment coordination.

## Solution
A self-service Career Site Builder powered by an AI agent.

The company administrator can:
- Import an existing Figma design
- Start from an approved base career site
- Describe desired changes in natural language
- Add supported functional capabilities
- Review a generated site plan
- Preview changes
- View versions and changes
- Request publication

## Non-Goals for MVP
- Direct production deployment by company administrators
- Arbitrary editing of backend or API logic
- Generating unsupported career functionality
- Pixel-perfect reproduction of every Figma design
- Exposing the internal production codebase

## Success Criteria
- Demonstrate both entry flows
- Generate a structured Site Blueprint
- Reuse at least one functional component from `zm-careers-lib`
- Allow at least one conversational modification
- Generate or update a preview
- Persist a version/change record
