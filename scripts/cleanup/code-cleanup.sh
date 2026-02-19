#!/bin/bash
# Code Cleanup Script for warmreach
# Uses AST-aware tools: knip (JS/TS), vulture (Python), ruff (Python)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPORT_DIR="$REPO_ROOT/reports"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Source lib modules
source "$SCRIPT_DIR/lib/analyze-js.sh"
source "$SCRIPT_DIR/lib/analyze-py.sh"
source "$SCRIPT_DIR/lib/sanitize.sh"
source "$SCRIPT_DIR/lib/report.sh"

echo "=== Code Cleanup Script ==="
echo "Repository: $REPO_ROOT"
echo "Timestamp: $TIMESTAMP"
echo ""

# Check for required tools
check_tool() {
    if ! command -v "$1" &> /dev/null; then
        echo "WARNING: $1 not found. Install with: $2"
        return 1
    fi
    return 0
}

# --- JavaScript/TypeScript Cleanup (Legacy) ---
js_cleanup() {
    echo "=== JavaScript/TypeScript Cleanup ==="

    # Run knip for unused exports/dependencies detection
    if check_tool "npx" "npm install -g npm"; then
        echo "Running knip for dead code detection..."
        cd "$REPO_ROOT"
        npx knip --reporter json > "$REPORT_DIR/knip-report-$TIMESTAMP.json" 2>/dev/null || true
        echo "Knip report saved to: $REPORT_DIR/knip-report-$TIMESTAMP.json"
    fi

    # Lint check with strict mode
    echo "Running ESLint (strict)..."
    cd "$REPO_ROOT/frontend"
    npm run lint 2>&1 || echo "ESLint found issues (expected during cleanup)"

    cd "$REPO_ROOT/client"
    npm run lint 2>&1 || echo "ESLint found issues (expected during cleanup)"
}

# --- Python Cleanup (Legacy) ---
py_cleanup() {
    echo ""
    echo "=== Python Cleanup ==="

    # Run vulture for dead code detection
    if check_tool "uvx" "pip install uv"; then
        echo "Running vulture for dead code detection..."
        uvx vulture "$REPO_ROOT/backend/lambdas" \
            --exclude "$REPO_ROOT/backend/.aws-sam" \
            --min-confidence 80 \
            > "$REPORT_DIR/vulture-report-$TIMESTAMP.txt" 2>&1 || true
        echo "Vulture report saved to: $REPORT_DIR/vulture-report-$TIMESTAMP.txt"
    fi

    # Run ruff with T20 (print) and ERA (commented code) rules
    echo "Running Ruff linting..."
    cd "$REPO_ROOT/backend"
    uvx ruff check lambdas --exclude .aws-sam 2>&1 || echo "Ruff found issues (expected during cleanup)"
}

# --- Generate Summary (Legacy) ---
generate_summary() {
    echo ""
    echo "=== Cleanup Summary ==="
    echo "Reports generated in: $REPORT_DIR"
    echo ""
    echo "Files checked:"
    find "$REPO_ROOT/frontend/src" -name "*.ts" -o -name "*.tsx" | wc -l | xargs echo "  - TypeScript files:"
    find "$REPO_ROOT/client/src" -name "*.js" | wc -l | xargs echo "  - Puppeteer JS files:"
    find "$REPO_ROOT/backend/lambdas" -name "*.py" ! -path "*/.aws-sam/*" | wc -l | xargs echo "  - Python Lambda files:"
    echo ""
    echo "To view reports:"
    echo "  cat $REPORT_DIR/knip-report-$TIMESTAMP.json"
    echo "  cat $REPORT_DIR/vulture-report-$TIMESTAMP.txt"
}

# --- Full Analysis Phase ---
run_analysis() {
    local start_time=$(date +%s)
    echo ""
    echo "=== Analysis Phase ==="

    analyze_frontend
    analyze_client
    analyze_backend
    scan_js_secrets
    scan_py_secrets

    local end_time=$(date +%s)
    echo "  Analysis completed in $((end_time - start_time))s"
}

# --- Sanitization Phase ---
run_sanitization() {
    local start_time=$(date +%s)
    echo ""
    echo "=== Sanitization Phase ==="

    remove_console_logs
    remove_print_statements
    remove_debugger_statements
    find_todo_comments

    local end_time=$(date +%s)
    echo "  Sanitization completed in $((end_time - start_time))s"
}

# --- Report Generation Phase ---
run_report() {
    local start_time=$(date +%s)
    echo ""
    echo "=== Report Generation Phase ==="

    generate_json_report
    generate_markdown_report
    print_summary

    local end_time=$(date +%s)
    echo "  Report generation completed in $((end_time - start_time))s"
}

# --- Main ---
main() {
    mkdir -p "$REPORT_DIR"

    case "${1:-all}" in
        js)
            js_cleanup
            ;;
        py)
            py_cleanup
            ;;
        all)
            js_cleanup
            py_cleanup
            generate_summary
            ;;
        audit)
            echo "Audit-only mode: generating reports without modifications"
            run_analysis
            run_report
            ;;
        sanitize)
            echo "Sanitize mode: applying automated fixes only"
            run_sanitization
            ;;
        full)
            echo "Full mode: analysis + sanitization + report"
            run_analysis
            run_sanitization
            run_report
            ;;
        *)
            echo "Usage: $0 [js|py|all|audit|sanitize|full]"
            echo ""
            echo "Modes:"
            echo "  js       - JavaScript/TypeScript cleanup (legacy)"
            echo "  py       - Python cleanup (legacy)"
            echo "  all      - All legacy cleanup (default)"
            echo "  audit    - Analysis and report only (no modifications)"
            echo "  sanitize - Apply automated fixes only"
            echo "  full     - Complete: analysis + sanitization + report"
            exit 1
            ;;
    esac
}

main "$@"
