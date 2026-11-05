// Package web embeds the static UI.
package web

import "embed"

// FS holds the UI under static/.
//
//go:embed static
var FS embed.FS
