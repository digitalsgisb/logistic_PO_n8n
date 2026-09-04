# Verification record

Verified on 4 September 2026 with Node 24.12.0 on Windows.

## Completed checks

- TypeScript checking and production Vite build passed.
- Automated API and mapping tests passed, covering four orders and all nine line items, destination suffixes, source validation, PDF overlay deduplication, multi-page orders, duplicate uploads, partial success, restart/retry, authenticated downloads, ZIP generation, and stale callbacks.
- Live Ollama extraction ran against the user's AI Atom server at `100.109.37.96:11434` using `glm-4.7-flash:q8_0`.
- All extracted fields and all nine item lines exactly matched the expected sample fixtures. Four output workbooks were generated and their cell mappings checked.
- The template and representative Shah Alam/Bukit Raja outputs were rendered and visually inspected. Full KB identifiers stay within their columns.
- Desktop (1440 pixels) and mobile (390 pixels) browser checks covered login, file selection, removal, disabled empty submission, and responsive layout. No browser JavaScript errors or horizontal mobile overflow were detected.

## Deployment status

The application is prepared for GitHub and Docker deployment. The development computer has no Docker Engine or LibreOffice installation. The bundled template uses the documented BIFF style-preserving preparation fallback; the normal LibreOffice regeneration script is supplied.

SSH to the AI Atom server was reachable, but `sugidigital` authentication was unavailable. The user chose GitHub-based deployment. Docker container builds and activation of the imported workflow on the existing n8n instance still require the server deployment steps in the README. The live Ollama test is not represented as an end-to-end run through the user's n8n instance.
