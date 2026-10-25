const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) e.target.classList.add('is-visible');
});
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

function initCarousel() { /* nothing to do on this page */ }
initCarousel();
