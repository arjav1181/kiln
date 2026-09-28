document.querySelector('#submit-btn').addEventListener('click', () => {
  console.error('fixture: deliberate console error');
  document.querySelector('h1').textContent = 'Clicked';
});
