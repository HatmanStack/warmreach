# Build Resources

Place platform-specific icons here before running `electron-builder`:

| File | Size | Platform |
|------|------|----------|
| `icon.icns` | 1024x1024 | macOS |
| `icon.ico` | 256x256 | Windows |
| `icon.png` | 512x512 | Linux |

Generate all formats from a single 1024x1024 PNG using:
```bash
# macOS (requires iconutil)
iconutil -c icns icon.iconset

# All platforms (requires electron-icon-builder)
npx electron-icon-builder --input=icon-1024.png --output=build
```
