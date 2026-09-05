# Career Site Builder Agent

## Goal
Build an AI-powered self-service platform that enables company administrators to create, customize, preview, and request publication of fully functional career sites.

## Core Value
Companies should not need to involve the development team for every initial setup, content update, design adjustment, or supported functional capability.

## Supported Starting Points
1. **Import Existing Figma** — Analyze an existing company design through Figma MCP.
2. **Start From Base** — Read and customize an approved default career site using GitHub MCP.

## Key Principle
The AI must not treat generated React code as the primary source of truth.

The source of truth is a structured **Site Blueprint**:

Figma / Base Site / User Request
→ Agent Orchestration
→ Site Blueprint
→ Renderer / Code Changes
→ Preview
→ Publish Request

## Functional Components
Use the approved `zm-careers-lib` component library for functional career capabilities.

The agent should reuse supported components instead of generating functional implementations from scratch.

## Primary MVP
- Figma import
- Start from base career site
- AI-generated site plan
- Component discovery and mapping
- Conversational site modifications
- Live preview
- GitHub branch/version creation
- Publish request workflow

See the remaining markdown files for implementation details.
