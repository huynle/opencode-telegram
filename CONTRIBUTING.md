# Contributing to OpenCode Telegram Integration

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/opencode-telegram.git
   cd opencode-telegram
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/huynle/opencode-telegram.git
   ```

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- [OpenCode](https://opencode.ai) CLI installed
- A Telegram bot token (for testing)
- A Telegram supergroup with topics enabled

### Installation

```bash
# Install dependencies
bun install

# Copy environment template
cp .env.example .env

# Edit .env with your test credentials
# Use a separate bot/group for development!
```

### Running Locally

```bash
# Development mode with hot reload
bun run dev

# Type checking
bun run typecheck
```

### Project Structure

```
src/
├── index.ts              # Entry point
├── config.ts             # Configuration
├── integration.ts        # Main orchestration
├── api-server.ts         # External API
├── bot/handlers/         # Telegram command handlers
├── forum/                # Topic management
├── opencode/             # OpenCode client & streaming
├── orchestrator/         # Instance lifecycle management
└── types/                # TypeScript type definitions
```

## Making Changes

### Branch Naming

Use descriptive branch names:

- `feature/add-webhook-support` - New features
- `fix/duplicate-messages` - Bug fixes
- `docs/update-readme` - Documentation
- `refactor/simplify-stream-handler` - Code improvements

### Commit Messages

Write clear, concise commit messages:

```
feat: add webhook support for production deployments

- Add TELEGRAM_WEBHOOK_URL config option
- Implement webhook handler in api-server.ts
- Update README with webhook setup instructions

Closes #123
```

**Format**: `type: short description`

**Types**:
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only
- `refactor` - Code change that neither fixes a bug nor adds a feature
- `test` - Adding or updating tests
- `chore` - Maintenance tasks

## Pull Request Process

1. **Update your fork**:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes** and commit them

4. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request** against the `main` branch

6. **Fill out the PR template** completely

7. **Address review feedback** promptly

### PR Requirements

- [ ] Code passes type checking (`bun run typecheck`)
- [ ] New features include documentation updates
- [ ] Breaking changes are clearly noted
- [ ] PR description explains the "why" not just the "what"

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Enable strict mode (already configured in `tsconfig.json`)
- Prefer explicit types over `any`
- Use interfaces for object shapes, types for unions/primitives

### Code Style

- Use 2-space indentation
- Use single quotes for strings
- No semicolons (Bun/modern JS style)
- Use `const` by default, `let` when reassignment needed

### File Organization

- One component/class per file
- Group related files in directories
- Export from `index.ts` files for cleaner imports
- Keep files under 300 lines when possible

### Error Handling

- Always handle errors gracefully
- Log errors with context
- Don't crash the bot on recoverable errors
- Use typed errors when possible

### Example

```typescript
// Good
interface TopicMapping {
  topicId: number
  sessionId: string
  projectPath: string
}

async function getMapping(topicId: number): Promise<TopicMapping | null> {
  try {
    const result = await db.get(topicId)
    return result ?? null
  } catch (error) {
    console.error(`[TopicStore] Failed to get mapping for topic ${topicId}:`, error)
    return null
  }
}

// Avoid
async function getMapping(topicId: any) {
  return await db.get(topicId)  // No error handling, any type
}
```

## Reporting Bugs

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md) and include:

1. **Clear description** of the bug
2. **Steps to reproduce** the issue
3. **Expected behavior** vs actual behavior
4. **Environment details** (OS, Bun version, etc.)
5. **Logs** if available (sanitize sensitive data!)

## Suggesting Features

Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md) and include:

1. **Problem statement** - What problem does this solve?
2. **Proposed solution** - How should it work?
3. **Alternatives considered** - Other approaches you thought about
4. **Additional context** - Mockups, examples, related issues

## Questions?

- Open a [Discussion](https://github.com/huynle/opencode-telegram/discussions) for questions
- Check existing issues before creating new ones
- Join the community chat (if available)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
