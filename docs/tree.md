# iana-registries-mcp-server - Directory Structure

Generated on: 2026-10-01 16:17:54

```text
iana-registries-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── get-registry-records.tool.ts
│   │       │   ├── get-rfc-status.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── lookup-http-field.tool.ts
│   │       │   ├── lookup-http-status.tool.ts
│   │       │   ├── lookup-language-tag.tool.ts
│   │       │   ├── lookup-media-type.tool.ts
│   │       │   ├── lookup-pen.tool.ts
│   │       │   ├── lookup-port.tool.ts
│   │       │   ├── lookup-uri-scheme.tool.ts
│   │       │   └── search-registries.tool.ts
│   │       └── shared/
│   │           ├── list-enrichment.ts
│   │           ├── markdown.ts
│   │           └── schemas.ts
│   ├── services/
│   │   ├── ietf/
│   │   │   ├── ietf-doc-service.ts
│   │   │   └── types.ts
│   │   ├── media-template/
│   │   │   ├── media-template-reader.ts
│   │   │   └── template-statements.ts
│   │   ├── registry/
│   │   │   ├── language-registry-parser.ts
│   │   │   ├── language-tag.ts
│   │   │   ├── pen-parser.ts
│   │   │   ├── personal-data.ts
│   │   │   ├── protocol-index-parser.ts
│   │   │   ├── registry-store.ts
│   │   │   ├── registry-tables.ts
│   │   │   ├── search-text.ts
│   │   │   ├── types.ts
│   │   │   └── xml-registry-parser.ts
│   │   └── upstream/
│   │       ├── call-budget.ts
│   │       └── upstream-client.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── http-registries.ts
│   │   ├── ietf.ts
│   │   ├── language-registry.ts
│   │   ├── language-tags.ts
│   │   ├── media-registry.ts
│   │   ├── pen.ts
│   │   ├── port-registry.ts
│   │   ├── protocol-index.ts
│   │   ├── records-xml.ts
│   │   ├── registry-xml.ts
│   │   └── search-index.ts
│   ├── services/
│   │   ├── ietf/
│   │   │   └── ietf-doc-service.test.ts
│   │   ├── media-template/
│   │   │   ├── media-template-reader.test.ts
│   │   │   └── template-statements.test.ts
│   │   ├── registry/
│   │   │   ├── language-registry-parser.test.ts
│   │   │   ├── language-tag.test.ts
│   │   │   ├── pen-parser.test.ts
│   │   │   ├── personal-data.test.ts
│   │   │   ├── protocol-index-parser.test.ts
│   │   │   ├── registry-store.test.ts
│   │   │   ├── search-text.test.ts
│   │   │   └── xml-registry-parser.test.ts
│   │   └── upstream/
│   │       ├── call-budget.test.ts
│   │       └── upstream-client.test.ts
│   ├── shared/
│   │   ├── failure-contract.ts
│   │   ├── format-parity.test.ts
│   │   ├── format-parity.ts
│   │   ├── tool-harness.ts
│   │   └── upstream-harness.ts
│   └── tools/
│       ├── format-blockquotes.test.ts
│       ├── get-registry-records.test.ts
│       ├── get-rfc-status.test.ts
│       ├── list-enrichment.test.ts
│       ├── lookup-http-field.test.ts
│       ├── lookup-http-status.test.ts
│       ├── lookup-language-tag.test.ts
│       ├── lookup-media-type.test.ts
│       ├── lookup-pen.test.ts
│       ├── lookup-port.test.ts
│       ├── lookup-uri-scheme.test.ts
│       ├── markdown.test.ts
│       ├── schemas.test.ts
│       └── search-registries.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
