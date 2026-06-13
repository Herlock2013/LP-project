document.addEventListener('DOMContentLoaded', () => {
    // Hamburger Menu Toggle
    const hamburger = document.getElementById('hamburger');
    const nav = document.getElementById('nav');
    
    if (hamburger && nav) {
        hamburger.addEventListener('click', () => {
            hamburger.classList.toggle('active');
            nav.classList.toggle('active');
        });
    }
    // Header scroll effect
    const header = document.getElementById('header');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            header.classList.add('scrolled');
        } else {
            header.classList.remove('scrolled');
        }
    });

    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                // Close mobile menu if open
                if (hamburger && hamburger.classList.contains('active')) {
                    hamburger.classList.remove('active');
                    nav.classList.remove('active');
                }

                window.scrollTo({
                    top: targetElement.offsetTop - 80, // Offset for fixed header
                    behavior: 'smooth'
                });
            }
        });
    });

    // Intersection Observer for fade-in animations
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.05 // 視認性のタイミングを早めにするため、交差基準を低めに設定
    };

    const observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target); // 表示されたら監視を終了してリソースを解放
            }
        });
    }, observerOptions);

    const animatedElements = document.querySelectorAll('.fade-in, .fade-in-up');
    animatedElements.forEach(el => observer.observe(el));

    // Gallery lightbox
    const galleryImages = Array.from(document.querySelectorAll('.gallery-grid img'));
    if (galleryImages.length) {
        const lightbox = document.createElement('div');
        lightbox.className = 'gallery-lightbox';
        lightbox.setAttribute('role', 'dialog');
        lightbox.setAttribute('aria-modal', 'true');
        lightbox.setAttribute('aria-label', 'Gallery image preview');
        lightbox.innerHTML = `
            <button class="gallery-lightbox__close" type="button" aria-label="Close image">&times;</button>
            <button class="gallery-lightbox__nav gallery-lightbox__nav--prev" type="button" aria-label="Previous image">&lsaquo;</button>
            <figure class="gallery-lightbox__figure">
                <img class="gallery-lightbox__image" src="" alt="">
            </figure>
            <button class="gallery-lightbox__nav gallery-lightbox__nav--next" type="button" aria-label="Next image">&rsaquo;</button>
        `;
        document.body.appendChild(lightbox);

        const lightboxImage = lightbox.querySelector('.gallery-lightbox__image');
        const closeButton = lightbox.querySelector('.gallery-lightbox__close');
        const prevButton = lightbox.querySelector('.gallery-lightbox__nav--prev');
        const nextButton = lightbox.querySelector('.gallery-lightbox__nav--next');
        let currentIndex = 0;

        const showImage = (index) => {
            currentIndex = (index + galleryImages.length) % galleryImages.length;
            const image = galleryImages[currentIndex];
            lightboxImage.src = image.currentSrc || image.src;
            lightboxImage.alt = image.alt || '';
        };

        const openLightbox = (index) => {
            showImage(index);
            lightbox.classList.add('is-open');
            document.body.classList.add('lightbox-open');
            closeButton.focus();
        };

        const closeLightbox = () => {
            lightbox.classList.remove('is-open');
            document.body.classList.remove('lightbox-open');
            lightboxImage.removeAttribute('src');
        };

        galleryImages.forEach((image, index) => {
            image.setAttribute('tabindex', '0');
            image.setAttribute('role', 'button');
            image.setAttribute('aria-label', `${image.alt || 'Gallery image'}を拡大表示`);
            image.addEventListener('click', () => openLightbox(index));
            image.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openLightbox(index);
                }
            });
        });

        closeButton.addEventListener('click', closeLightbox);
        prevButton.addEventListener('click', () => showImage(currentIndex - 1));
        nextButton.addEventListener('click', () => showImage(currentIndex + 1));

        lightbox.addEventListener('click', (event) => {
            if (event.target === lightbox) closeLightbox();
        });

        document.addEventListener('keydown', (event) => {
            if (!lightbox.classList.contains('is-open')) return;
            if (event.key === 'Escape') closeLightbox();
            if (event.key === 'ArrowLeft') showImage(currentIndex - 1);
            if (event.key === 'ArrowRight') showImage(currentIndex + 1);
        });
    }
    
    // Trigger animations for elements already in viewport on load
    setTimeout(() => {
        // .hero要素自身、およびその中のfade-in対象要素を初期表示
        const heroElements = document.querySelectorAll('.hero, .hero .fade-in, .hero .fade-in-up');
        heroElements.forEach(el => el.classList.add('visible'));
    }, 100);
});
