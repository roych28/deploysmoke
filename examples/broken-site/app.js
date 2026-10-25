// planted bug 4: observes the wrong selector, so .reveal never becomes visible
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) e.target.classList.add('is-visible');
});
document.querySelectorAll('.reveal-on-scroll').forEach((el) => io.observe(el));

// planted bug 2: this function was renamed in another file and this call was missed
initCarousel();
