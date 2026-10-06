// --- BATTLE PASS EASTER EGG MODAL ---
function initBattlepassEvents() {
  const openBpBtn = document.getElementById('btn-open-battlepass');
  const buyBpBtn = document.getElementById('btn-buy-battlepass');
  const claimXpBtn = document.getElementById('btn-claim-daily-xp');
  const modalBp = document.getElementById('modal-battlepass');

  if (openBpBtn && modalBp) {
    openBpBtn.addEventListener('click', () => {
      modalBp.classList.add('open');
    });
  }

  if (buyBpBtn) {
    buyBpBtn.addEventListener('click', () => {
      buyBpBtn.innerHTML = 'Activated!';
      buyBpBtn.disabled = true;
    });
  }

  if (claimXpBtn) {
    claimXpBtn.addEventListener('click', () => {
      claimXpBtn.innerHTML = 'Claimed!';
      claimXpBtn.disabled = true;
    });
  }
}
