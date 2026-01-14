(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like environments that support module.exports,
        // like Node.
        module.exports = factory();
    } else {
        // Browser globals (root is window)
        root.MarbleGenerator = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    // Simple hash function to get deterministic numbers from strings
    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }

    // Seeded random number generator
    function mulberry32(a) {
        return function () {
            var t = a += 0x6D2B79F5;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }
    }

    // HSL to Hex helper
    function hslToHex(h, s, l) {
        l /= 100;
        const a = s * Math.min(l, 1 - l) / 100;
        const f = n => {
            const k = (n + h / 30) % 12;
            const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
            return Math.round(255 * color).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    }

    function generateMarble(id, size = 100, agentName = '', uniqueSuffix = '') {
        const seed = hashString(String(id));
        const rand = mulberry32(seed);
        const uniqueId = `planet-${seed}${uniqueSuffix ? '-' + uniqueSuffix : ''}`;

        // Planet Parameters
        const hue = Math.floor(rand() * 360);
        const planetType = Math.floor(rand() * 5); // 0: Terran, 1: Gas, 2: Ice, 3: Lava, 4: Desert
        const hasRings = false; // Rings disabled per user request
        const ringTilt = (rand() * 40) - 20; // Tilt in degrees

        // Dimensions
        const radius = 45; // Always use large radius since rings are disabled
        const cx = 50;
        const cy = 50;

        // Colors & Filters
        let defs = '';
        let surface = '';
        let atmosphere = '';

        // Common Gradients
        const shadowGradient = `
            <radialGradient id="shadow-${uniqueId}" cx="25%" cy="25%" r="100%">
                <stop offset="0%" stop-color="white" stop-opacity="0.1" />
                <stop offset="40%" stop-color="transparent" stop-opacity="0" />
                <stop offset="80%" stop-color="black" stop-opacity="0.4" />
                <stop offset="100%" stop-color="black" stop-opacity="0.7" />
            </radialGradient>
        `;

        // Specular Highlight (Glossy Shine)
        const specularGradient = `
            <radialGradient id="specular-${uniqueId}" cx="35%" cy="35%" r="60%">
                <stop offset="0%" stop-color="white" stop-opacity="0.6" />
                <stop offset="20%" stop-color="white" stop-opacity="0.2" />
                <stop offset="100%" stop-color="white" stop-opacity="0" />
            </radialGradient>
        `;

        // Planet Specifics
        if (planetType === 0) { // Terran (Noise for continents) - More vibrant
            const oceanColor = hslToHex(hue, 80, 40); // More saturated ocean
            const landColor = hslToHex((hue + 100) % 360, 60, 50); // More saturated land

            defs += `
                <filter id="terran-${uniqueId}">
                    <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="5" seed="${seed}" result="noise" />
                    <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -9" in="noise" result="mask" />
                    <feComposite operator="in" in="SourceGraphic" in2="mask" />
                </filter>
            `;

            surface = `
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${oceanColor}" />
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${landColor}" filter="url(#terran-${uniqueId})" />
            `;
            atmosphere = hslToHex(200, 90, 70);

        } else if (planetType === 1) { // Gas Giant (Banded) - More vibrant
            const c1 = hslToHex(hue, 90, 60);
            const c2 = hslToHex((hue + 30) % 360, 80, 50);
            const c3 = hslToHex((hue - 30) % 360, 80, 40);

            defs += `
                <linearGradient id="gas-${uniqueId}" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="${c1}" />
                    <stop offset="20%" stop-color="${c2}" />
                    <stop offset="40%" stop-color="${c1}" />
                    <stop offset="60%" stop-color="${c3}" />
                    <stop offset="80%" stop-color="${c2}" />
                    <stop offset="100%" stop-color="${c1}" />
                </linearGradient>
                <filter id="gas-turb-${uniqueId}">
                    <feTurbulence type="fractalNoise" baseFrequency="0.01 0.1" numOctaves="3" seed="${seed}" />
                    <feDisplacementMap in="SourceGraphic" scale="10" />
                </filter>
            `;

            surface = `
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="url(#gas-${uniqueId})" filter="url(#gas-turb-${uniqueId})" />
            `;
            atmosphere = c1;

        } else if (planetType === 2) { // Ice (Crystalline) - More colorful ice
            const c1 = hslToHex(hue, 60, 80); // Tinted ice base
            const c2 = hslToHex((hue + 180) % 360, 70, 60); // Contrast reflection

            defs += `
                <filter id="ice-${uniqueId}">
                    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="${seed}" />
                    <feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 5 -2" />
                </filter>
            `;

            surface = `
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${c1}" />
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${c2}" filter="url(#ice-${uniqueId})" opacity="0.6" />
            `;
            atmosphere = hslToHex(hue, 50, 90);

        } else if (planetType === 3) { // Lava (Glowing cracks) - More intense
            const c1 = '#330000';
            const c2 = '#ff5500';

            defs += `
                <filter id="lava-${uniqueId}">
                    <feTurbulence type="turbulence" baseFrequency="0.05" numOctaves="4" seed="${seed}" />
                    <feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 25 -12" />
                </filter>
            `;

            surface = `
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${c1}" />
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${c2}" filter="url(#lava-${uniqueId})" />
            `;
            atmosphere = '#ff5500';

        } else { // Desert (Dunes) - More saturated
            const c1 = hslToHex(hue, 70, 60); // Alien desert
            const c2 = hslToHex(hue, 60, 40);

            defs += `
                <filter id="desert-${uniqueId}">
                    <feTurbulence type="fractalNoise" baseFrequency="0.02 0.05" numOctaves="3" seed="${seed}" />
                </filter>
            `;

            surface = `
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${c1}" />
                <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${c2}" filter="url(#desert-${uniqueId})" opacity="0.5" />
            `;
            atmosphere = hslToHex(hue, 80, 70);
        }

        // Rings
        let backRing = '';
        let frontRing = '';
        if (hasRings) {
            const ringColor = hslToHex(hue, 60, 80); // Brighter rings
            const rx = radius * 1.8;
            const ry = radius * 0.5;

            // Clip path to show only the front part of the ring (e.g. lower half)
            defs += `
                <clipPath id="ring-clip-${uniqueId}">
                    <rect x="0" y="${cy}" width="100" height="50" />
                </clipPath>
            `;

            backRing = `<g opacity="0.8" transform="rotate(${ringTilt} ${cx} ${cy})">
                <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${ringColor}" stroke-width="${radius * 0.15}" />
                <ellipse cx="${cx}" cy="${cy}" rx="${rx * 0.9}" ry="${ry * 0.9}" fill="none" stroke="${ringColor}" stroke-width="${radius * 0.05}" opacity="0.5" />
            </g>`;

            frontRing = `<g opacity="0.9" transform="rotate(${ringTilt} ${cx} ${cy})" clip-path="url(#ring-clip-${uniqueId})">
                <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${ringColor}" stroke-width="${radius * 0.15}" />
                <ellipse cx="${cx}" cy="${cy}" rx="${rx * 0.9}" ry="${ry * 0.9}" fill="none" stroke="${ringColor}" stroke-width="${radius * 0.05}" opacity="0.5" />
            </g>`;
        }

        // Atmosphere Glow
        const glow = `
            <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${atmosphere}" stroke-width="2" opacity="0.6" filter="url(#glow-${uniqueId})" />
        `;
        defs += `
            <filter id="glow-${uniqueId}">
                <feGaussianBlur stdDeviation="2.5" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        `;

        return `
            <svg viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
                <defs>
                    ${shadowGradient}
                    ${specularGradient}
                    ${defs}
                    <clipPath id="planet-clip-${uniqueId}">
                        <circle cx="${cx}" cy="${cy}" r="${radius}" />
                    </clipPath>
                </defs>
                
                <!-- Back Ring -->
                ${backRing}
                
                <!-- Planet Body -->
                <g clip-path="url(#planet-clip-${uniqueId})">
                    ${surface}
                    <!-- Shadow/Lighting Overlay -->
                    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="url(#shadow-${uniqueId})" />
                    <!-- Specular Highlight (Gloss) -->
                    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="url(#specular-${uniqueId})" style="mix-blend-mode: overlay;" />
                </g>
                
                <!-- Front Ring -->
                ${frontRing}
                
                <!-- Atmosphere/Glow -->
                ${glow}
            </svg>
        `;
    }

    return {
        generateMarble: generateMarble
    };

}));
