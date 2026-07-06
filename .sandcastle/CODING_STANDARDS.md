# Coding Standards

<!-- Customize this file with your project's coding standards.
     The reviewer agent loads it during code review via @.sandcastle/CODING_STANDARDS.md
     so these standards are enforced during review without costing tokens during implementation. -->

- Write code for long-term maintainability and human readability.
- Do not over-engineer. Only make changes that are clearly necessary.

## Style

- Use camelCase for variables and functions
- Use PascalCase for classes and types
- Prefer named exports over default exports

## Testing

- Every public function must have at least one test
- Use descriptive test names that explain the expected behavior

## Architecture

- Keep modules focused on a single responsibility
- Prefer composition over inheritance
