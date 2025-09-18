// Add interactivity for the Go button
window.addEventListener('DOMContentLoaded', function() {
    var goBtn = document.getElementById('go-btn');
    if (goBtn) {
        goBtn.addEventListener('click', function() {
            window.open('https://eeveeandchar-studios.ct.ws', '_blank');
        });
    }
});
