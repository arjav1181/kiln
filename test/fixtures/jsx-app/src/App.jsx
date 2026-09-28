export function App() {
  return (
    <main className="app">
      <h1>JSX fixture</h1>
      <button id="submit-btn" className="primary">
        Submit
      </button>
      <Footer />
    </main>
  );
}

function Footer() {
  return <footer className="footer">kiln</footer>;
}
