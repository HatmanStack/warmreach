#!/bin/bash
# Audit Report Generator Module
# Generates JSON and Markdown reports

# Global variables for report data (set by analysis functions)
# Only initialize if not already set by other modules
: "${FRONTEND_DEAD_CODE:={}}"
: "${CLIENT_DEAD_CODE:={}}"
: "${BACKEND_DEAD_CODE:={}}"
: "${JS_SECRETS:={}}"
: "${PY_SECRETS:={}}"
: "${SANITIZATION_FINDINGS:={}}"

# Generate JSON audit report
generate_json_report() {
    echo "  → Generating JSON report..."

    local output_file="$REPORT_DIR/audit-report.json"
    local timestamp
    timestamp=$(date -Iseconds)

    # Count issues from knip reports
    local frontend_files=0 frontend_issues=0
    local client_files=0 client_issues=0

    if [[ -n "$FRONTEND_DEAD_CODE" ]] && [[ "$FRONTEND_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            frontend_files=$(echo "$FRONTEND_DEAD_CODE" | jq '.files | length // 0' 2>/dev/null || echo "0")
            frontend_issues=$(echo "$FRONTEND_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    if [[ -n "$CLIENT_DEAD_CODE" ]] && [[ "$CLIENT_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            client_files=$(echo "$CLIENT_DEAD_CODE" | jq '.files | length // 0' 2>/dev/null || echo "0")
            client_issues=$(echo "$CLIENT_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    # Count backend issues
    local backend_issues=0
    if [[ -n "$BACKEND_DEAD_CODE" ]] && [[ "$BACKEND_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            backend_issues=$(echo "$BACKEND_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    # Create the JSON report
    cat > "$output_file" <<EOF
{
  "timestamp": "$timestamp",
  "components": {
    "frontend": {
      "deadCode": {
        "unusedFiles": $frontend_files,
        "issues": $frontend_issues,
        "rawReport": "$REPORT_DIR/knip-frontend-$TIMESTAMP.json"
      }
    },
    "client": {
      "deadCode": {
        "unusedFiles": $client_files,
        "issues": $client_issues,
        "rawReport": "$REPORT_DIR/knip-client-$TIMESTAMP.json"
      }
    },
    "backend": {
      "deadCode": {
        "issues": $backend_issues,
        "rawReport": "$REPORT_DIR/vulture-backend-$TIMESTAMP.txt"
      }
    }
  },
  "secrets": {
    "jsSecrets": "$REPORT_DIR/secrets-js-$TIMESTAMP.json",
    "pySecrets": "$REPORT_DIR/secrets-py-$TIMESTAMP.json"
  },
  "sanitization": {
    "consoleLogs": "$REPORT_DIR/sanitize-console-$TIMESTAMP.txt",
    "printStatements": "$REPORT_DIR/sanitize-print-$TIMESTAMP.txt",
    "debuggerStatements": "$REPORT_DIR/sanitize-debugger-$TIMESTAMP.txt",
    "todoComments": "$REPORT_DIR/sanitize-todo-$TIMESTAMP.txt"
  },
  "summary": {
    "totalDeadCodeFiles": $((frontend_files + client_files)),
    "totalDeadCodeIssues": $((frontend_issues + client_issues + backend_issues))
  }
}
EOF

    if [[ -f "$output_file" ]]; then
        echo "    ✓ JSON report saved: $output_file"
    else
        echo "    ⚠ Failed to generate JSON report"
    fi
}

# Generate human-readable Markdown report
generate_markdown_report() {
    echo "  → Generating Markdown report..."

    local output_file="$REPORT_DIR/audit-report.md"
    local timestamp
    timestamp=$(date "+%Y-%m-%d %H:%M:%S")

    # Count issues
    local frontend_files=0 frontend_issues=0
    local client_files=0 client_issues=0
    local backend_issues=0

    if [[ -n "$FRONTEND_DEAD_CODE" ]] && [[ "$FRONTEND_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            frontend_files=$(echo "$FRONTEND_DEAD_CODE" | jq '.files | length // 0' 2>/dev/null || echo "0")
            frontend_issues=$(echo "$FRONTEND_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    if [[ -n "$CLIENT_DEAD_CODE" ]] && [[ "$CLIENT_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            client_files=$(echo "$CLIENT_DEAD_CODE" | jq '.files | length // 0' 2>/dev/null || echo "0")
            client_issues=$(echo "$CLIENT_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    if [[ -n "$BACKEND_DEAD_CODE" ]] && [[ "$BACKEND_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            backend_issues=$(echo "$BACKEND_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    # Count sanitization findings from files
    local console_count=0 todo_count=0

    if [[ -f "$REPORT_DIR/sanitize-console-$TIMESTAMP.txt" ]]; then
        console_count=$(wc -l < "$REPORT_DIR/sanitize-console-$TIMESTAMP.txt" 2>/dev/null || echo "0")
        console_count="${console_count//[[:space:]]/}"
    fi
    if [[ -f "$REPORT_DIR/sanitize-todo-$TIMESTAMP.txt" ]]; then
        todo_count=$(wc -l < "$REPORT_DIR/sanitize-todo-$TIMESTAMP.txt" 2>/dev/null || echo "0")
        todo_count="${todo_count//[[:space:]]/}"
    fi

    cat > "$output_file" <<EOF
# Code Hygiene Audit Report

**Generated:** $timestamp
**Repository:** $REPO_ROOT

---

## Summary

| Component   | Unused Files | Dead Code Issues |
|-------------|-------------|------------------|
| Frontend    | $frontend_files | $frontend_issues |
| Client   | $client_files | $client_issues |
| Backend     | - | $backend_issues |
| **Total**   | $((frontend_files + client_files)) | $((frontend_issues + client_issues + backend_issues)) |

## Sanitization Findings

| Category | Files Affected |
|----------|---------------|
| Console statements | $console_count |
| TODO/FIXME comments | $todo_count |

---

## Detailed Reports

### Dead Code Analysis

- **Frontend (knip):** \`$REPORT_DIR/knip-frontend-$TIMESTAMP.json\`
- **Client (knip):** \`$REPORT_DIR/knip-client-$TIMESTAMP.json\`
- **Backend (vulture):** \`$REPORT_DIR/vulture-backend-$TIMESTAMP.txt\`

### Secrets Detection

- **JavaScript/TypeScript:** \`$REPORT_DIR/secrets-js-$TIMESTAMP.json\`
- **Python:** \`$REPORT_DIR/secrets-py-$TIMESTAMP.json\`

### Sanitization

- **Console statements:** \`$REPORT_DIR/sanitize-console-$TIMESTAMP.txt\`
- **TODO/FIXME comments:** \`$REPORT_DIR/sanitize-todo-$TIMESTAMP.txt\`

---

## Next Steps

1. Review the dead code reports and remove unused files/exports
2. Check secrets detection for any hardcoded credentials
3. Clean up console.log statements that aren't needed for error handling
4. Address or remove TODO/FIXME comments

EOF

    if [[ -f "$output_file" ]]; then
        echo "    ✓ Markdown report saved: $output_file"
    else
        echo "    ⚠ Failed to generate Markdown report"
    fi
}

# Print summary statistics to stdout
print_summary() {
    echo ""
    echo "=== Audit Summary ==="

    # Count issues
    local frontend_files=0 frontend_issues=0
    local client_files=0 client_issues=0
    local backend_issues=0

    if [[ -n "$FRONTEND_DEAD_CODE" ]] && [[ "$FRONTEND_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            frontend_files=$(echo "$FRONTEND_DEAD_CODE" | jq '.files | length // 0' 2>/dev/null || echo "0")
            frontend_issues=$(echo "$FRONTEND_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    if [[ -n "$CLIENT_DEAD_CODE" ]] && [[ "$CLIENT_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            client_files=$(echo "$CLIENT_DEAD_CODE" | jq '.files | length // 0' 2>/dev/null || echo "0")
            client_issues=$(echo "$CLIENT_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    if [[ -n "$BACKEND_DEAD_CODE" ]] && [[ "$BACKEND_DEAD_CODE" != "{}" ]]; then
        if command -v jq &> /dev/null; then
            backend_issues=$(echo "$BACKEND_DEAD_CODE" | jq '.issues | length // 0' 2>/dev/null || echo "0")
        fi
    fi

    local total_files=$((frontend_files + client_files))
    local total_issues=$((frontend_issues + client_issues + backend_issues))

    echo ""
    echo "Dead Code:"
    echo "  - Frontend: $frontend_files unused files, $frontend_issues issues"
    echo "  - Client: $client_files unused files, $client_issues issues"
    echo "  - Backend: $backend_issues issues"
    echo "  - Total: $total_files unused files, $total_issues issues"
    echo ""
    echo "Reports saved to: $REPORT_DIR/"
    echo "  - audit-report.json (machine-readable)"
    echo "  - audit-report.md (human-readable)"

    # Return exit code based on issues found
    if [[ $total_issues -gt 0 ]]; then
        echo ""
        echo "⚠ Issues found - review audit report for details"
    else
        echo ""
        echo "✓ No critical issues found"
    fi
}
