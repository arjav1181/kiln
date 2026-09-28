package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
)

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Kiln Go fixture</title>
  </head>
  <body>
    <main id="app">
      <h1>Go fixture</h1>
      <button id="submit-btn" class="primary">Submit</button>
    </main>
  </body>
</html>`

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// A real server would render; the point is the markup shape.
		fmt.Fprint(w, page)
	})

	// Bind an ephemeral port and announce it, so the probe never collides with
	// a stale listener.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("listening on %s", listener.Addr())
	log.Fatal(http.Serve(listener, nil))
}
