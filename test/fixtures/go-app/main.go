package main

import (
	"fmt"
	"html/template"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Deliberately split across several template files, the way a real Django,
// Rails or Go server is. T0 has no compiler index here, so locating an element
// means choosing between files, which is the case that actually matters.
type view struct {
	name     string
	filename string
}

var views = []view{
	{"nav", "nav.html"},
	{"form", "signup.html"},
	{"features", "features.html"},
	{"footer", "footer.html"},
}

func render(name string, data map[string]string) (string, error) {
	body, ok := findView(name)
	if !ok {
		return "", fmt.Errorf("no view %q", name)
	}
	parsed, err := template.New(name).Parse(body)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	if err := parsed.Execute(&out, data); err != nil {
		return "", err
	}
	return out.String(), nil
}

func findView(name string) (string, bool) {
	for _, v := range views {
		if v.name != name {
			continue
		}
		data, err := os.ReadFile(filepath.Join("templates", v.filename))
		return string(data), err == nil
	}
	return "", false
}

func page() string {
	sections := []struct {
		view string
		data map[string]string
	}{
		{"nav", map[string]string{"home": "Home", "about": "About"}},
		{"features", map[string]string{"title": "Go fixture"}},
		{"form", map[string]string{"action": "/subscribe"}},
		{"footer", map[string]string{"note": "kiln"}},
	}

	var body strings.Builder
	body.WriteString(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Kiln Go fixture</title>
  </head>
  <body>
`)
	for _, section := range sections {
		html, err := render(section.view, section.data)
		if err != nil {
			log.Printf("render %s: %v", section.view, err)
			continue
		}
		body.WriteString(html)
	}
	body.WriteString("  </body>\n</html>\n")
	return body.String()
}

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, page())
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("listening on %s", listener.Addr())
	log.Fatal(http.Serve(listener, nil))
}
