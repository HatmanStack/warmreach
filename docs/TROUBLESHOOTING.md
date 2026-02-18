# Troubleshooting Guide

This guide covers common issues encountered during development and deployment of the WarmReach tool.

## Client & LinkedIn Issues

### Authentication Failures
-   **Symptom**: "Login failed" or "Security checkpoint encountered."
-   **Solution**:
    -   Increase `LOGIN_SECURITY_TIMEOUT` in `.env` to allow more time for manual intervention if a CAPTCHA appears.
    -   Ensure your `VITE_CRED_SEALBOX_PUBLIC_KEY_B64` matches the keypair on the backend.
    -   Check if LinkedIn has flagged the IP. Try running in non-headless mode (`HEADLESS=false`) to see what's happening.

### Element Not Found
-   **Symptom**: Puppeteer fails to find a button or input field.
-   **Solution**:
    -   LinkedIn frequently updates its DOM. Check if the selectors in `client/src/domains/` need updating.
    -   Increase `ELEMENT_WAIT_TIMEOUT` in `.env`.
    -   Use `SCREENSHOT_ON_ERROR=true` to see the page state at the time of failure.

### Session Expired
-   **Symptom**: Automation stops working after a period of time.
-   **Solution**:
    -   LinkedIn sessions eventually expire. The "Heal & Restore" system should handle this, but you may need to re-authenticate manually if the session cannot be recovered.
    -   Adjust `LINKEDIN_SESSION_TIMEOUT` in `.env`.

## AWS & Deployment Issues

### SAM Build Failures
-   **Symptom**: `sam build` fails with dependency errors.
-   **Solution**:
    -   Ensure you have the correct Python version (3.13) installed.
    -   Check for syntax errors in `backend/template.yaml`.
    -   Clear the `.aws-sam` directory and try again.

### Lambda Permission Denied
-   **Symptom**: 403 Forbidden or 500 Internal Server Error when calling API.
-   **Solution**:
    -   Check CloudWatch Logs for the specific Lambda function.
    -   Verify that the IAM roles defined in `template.yaml` have the necessary permissions for DynamoDB, S3, and Bedrock/OpenAI.

### CORS Errors
-   **Symptom**: Frontend cannot communicate with the backend API.
-   **Solution**:
    -   Ensure `FRONTEND_URLS` in `.env` (or `ALLOWED_ORIGINS` in Lambda) includes your frontend's URL.
    -   Check the `API Gateway` configuration in the AWS Console to ensure CORS is enabled for the relevant resources.

## General Development

### Missing Environment Variables
-   **Symptom**: Application crashes or behaves unexpectedly.
-   **Solution**:
    -   Run `bash scripts/deploy/get-env-vars.sh <stack-name> --update-env` to ensure your `.env` is up to date with AWS resources.
    -   Compare your `.env` with `.env.example`.
