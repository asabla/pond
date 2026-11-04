// Package web embeds the static UI.
package web

import "embed"

//go:embed static
var FS embed.FS
