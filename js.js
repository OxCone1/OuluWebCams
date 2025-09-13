// Oulu WebCams - Enhanced Traffic Camera Monitor
class OuluWebCams {
    constructor() {
        this.cameras = [];
        this.allCameras = []; // Store original unfiltered cameras
        this.municipalityData = null;
        this.currentImages = [];
        this.cyclingInterval = null;
        this.currentCycleIndex = 0;
        this.lockedCameras = new Set();
        this.lastFullUpdate = null;
        this.isMobile = this.detectMobile(); // Add mobile detection

        // Configuration
        this.config = {
            cameraCount: 4,
            cycling: false,
            cyclingInterval: 5000,
            cyclingMode: 'all',
            selectedMunicipality: '',
            selectedStation: '',
            dropOldCameras: true,
            autoHideControls: true,
            hideTimeout: 2000,
            imageCache: new Map(),
            rateLimitBackoff: false
        };

        this.hideControlsTimer = null;
        this.uiHidden = false;
        this.init();
    }

    // Mobile detection method
    detectMobile() {
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;
        const screenWidth = window.screen.width;
        
        // Check for mobile user agents and screen size
        return (
            /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent) ||
            screenWidth <= 480 ||
            (window.matchMedia && window.matchMedia("(max-width: 480px)").matches)
        );
    }

    async init() {
        console.log('Initializing Oulu WebCams...');

        // Check if Turf is available
        if (typeof turf === 'undefined') {
            console.error('Turf.js is not loaded! Geospatial calculations will fail.');
            this.updateStatus('Turf.js library not loaded', 'error');
            return;
        } else {
            console.log('Turf.js loaded successfully');
        }

        try {
            await this.loadMunicipalityData();
            await this.loadCameras();
            this.setupEventListeners();
            this.setupMobileRestrictions(); // Add mobile-specific setup
            this.setupAutoHide();
            this.startPeriodicUpdates();
            this.startImageRefresh();
            this.updateStatus('Ready', 'success');
        } catch (error) {
            console.error('Initialization failed:', error);
            this.updateStatus('Failed to initialize', 'error');
        }
    }

    async loadMunicipalityData() {
        try {
            this.updateStatus('Loading municipality data...', 'loading');
            const response = await fetch('finnish-municipalities-wgs84.geojson');
            if (!response.ok) throw new Error('Failed to load municipality data');

            this.municipalityData = await response.json();
            console.log('Municipality data loaded:', this.municipalityData.features.length, 'municipalities');
        } catch (error) {
            console.error('Error loading municipality data:', error);
            throw error;
        }
    }

    async loadCameras() {
        try {
            this.updateStatus('Loading cameras...', 'loading');

            console.log('Making API request to fetch cameras...');

            const response = await fetch("https://api.oulunliikenne.fi/proxy/graphql", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    "operationName": "GetAllCameras",
                    "variables": {},
                    "query": "query GetAllCameras {cameras{cameraId,name,lat,lon,presets{presetId,presentationName,imageUrl,measuredTime}}}"
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            console.log('Received API response:', data.data.cameras.length, 'camera stations');

            this.processCameras(data.data.cameras);
            this.lastFullUpdate = new Date();

        } catch (error) {
            console.error('Error loading cameras:', error);
            this.updateStatus(`Failed to load cameras: ${error.message}`, 'error');
            throw error;
        }
    }

    processCameras(rawCameras) {
        console.log('Processing', rawCameras.length, 'camera stations...');

        const processedCameras = [];

        rawCameras.forEach((camera, index) => {
            const municipality = this.getMunicipalityForCamera(camera.lat, camera.lon);
            console.log(`Station ${index + 1}:`, camera.name, `at (${camera.lat}, ${camera.lon})`, '→', municipality);

            camera.presets.forEach(preset => {
                const processedCamera = {
                    ...preset,
                    stationName: camera.name,
                    cameraId: camera.cameraId,
                    lat: camera.lat,
                    lon: camera.lon,
                    municipality: municipality,
                    measuredTime: new Date(preset.measuredTime),
                    age: this.getImageAge(preset.measuredTime)
                };

                processedCameras.push(processedCamera);
            });
        });

        console.log('Processed', processedCameras.length, 'camera presets total');

        // Store original unfiltered cameras
        this.allCameras = processedCameras;
        
        // Filter cameras based on settings
        this.cameras = this.filterCameras(processedCameras);

        console.log(`After filtering: ${this.cameras.length} cameras available`);

        this.populateSelectors();
        this.renderCameras();

        this.updateStatus(
            `${this.cameras.length} cameras loaded`,
            'success'
        );
    }

    getMunicipalityForCamera(lat, lon) {
        if (!this.municipalityData) return 'Unknown';

        try {
            const point = turf.point([lon, lat]);

            for (const feature of this.municipalityData.features) {
                if (feature.geometry && feature.geometry.type === 'Polygon') {
                    const polygon = turf.polygon(feature.geometry.coordinates);
                    if (turf.booleanPointInPolygon(point, polygon)) {
                        return feature.properties.nimi || 'Unknown';
                    }
                } else if (feature.geometry && feature.geometry.type === 'MultiPolygon') {
                    const multiPolygon = turf.multiPolygon(feature.geometry.coordinates);
                    if (turf.booleanPointInPolygon(point, multiPolygon)) {
                        return feature.properties.nimi || 'Unknown';
                    }
                }
            }
        } catch (error) {
            console.error('Error determining municipality:', error);
        }

        return 'Unknown';
    }

    filterCameras(cameras) {
        let filtered = [...cameras];

        // Filter old cameras if enabled
        if (this.config.dropOldCameras) {
            const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
            filtered = filtered.filter(camera => camera.measuredTime > fourHoursAgo);
        }

        // Sort by freshness (newest first)
        filtered.sort((a, b) => b.measuredTime - a.measuredTime);

        return filtered;
    }

    getImageAge(timestamp) {
        const now = new Date();
        const imageTime = new Date(timestamp);
        const diffMs = now - imageTime;
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

        if (diffHours > 0) {
            return `${diffHours}h ${diffMins}m ago`;
        }
        return `${diffMins}m ago`;
    }

    populateSelectors() {
        // Populate municipality selector
        const municipalities = [...new Set(this.cameras.map(c => c.municipality))].sort();
        const municipalitySelect = document.getElementById('selectedMunicipality');
        municipalitySelect.innerHTML = '<option value="">All Municipalities</option>';
        municipalities.forEach(municipality => {
            const option = document.createElement('option');
            option.value = municipality;
            option.textContent = municipality;
            municipalitySelect.appendChild(option);
        });

        // Populate station selector  
        const stations = [...new Set(this.cameras.map(c => c.stationName))].sort();
        const stationSelect = document.getElementById('selectedStation');
        stationSelect.innerHTML = '<option value="">All Stations</option>';
        stations.forEach(station => {
            const option = document.createElement('option');
            option.value = station;
            option.textContent = station.replace(/_/g, ' ');
            stationSelect.appendChild(option);
        });
    }

    getFilteredCameras() {
        let filtered = [...this.cameras];

        switch (this.config.cyclingMode) {
            case 'municipality':
                if (this.config.selectedMunicipality) {
                    filtered = filtered.filter(c => c.municipality === this.config.selectedMunicipality);
                }
                break;
            case 'station':
                if (this.config.selectedStation) {
                    filtered = filtered.filter(c => c.stationName === this.config.selectedStation);
                }
                break;
        }

        return filtered;
    }

    getOptimalGridSize(cameraCount) {
        // Find the smallest standard grid size that can accommodate the cameras
        const standardGridSizes = [1, 2, 4, 6, 8, 12, 16];

        for (const gridSize of standardGridSizes) {
            if (cameraCount <= gridSize) {
                return gridSize;
            }
        }

        return 16; // Max grid size
    }

    renderCameras() {
        const grid = document.getElementById('cameraGrid');
        const availableCameras = this.getFilteredCameras();

        // Use configured count but limit to available cameras
        const requestedCount = this.config.cameraCount;
        const actualCameraCount = Math.min(requestedCount, availableCameras.length);

        if (availableCameras.length === 0) {
            this.showNoCamerasMessage();
            return;
        }

        // Use optimal grid size to minimize empty placeholders
        const optimalGridSize = this.getOptimalGridSize(actualCameraCount);

        // Update grid class based on optimal grid size
        let gridClass = `bc-grid bc-gap-4 bc-h-full grid-${optimalGridSize}`;
        
        // Add mobile-specific class if on mobile
        if (this.isMobile) {
            gridClass += ' mobile-optimized';
        }
        
        grid.className = gridClass;

        // Clear existing cameras
        grid.innerHTML = '';

        // Create camera containers for available cameras
        for (let i = 0; i < actualCameraCount; i++) {
            const container = this.createCameraContainer(i);
            grid.appendChild(container);
        }

        // Add empty placeholders only to fill the optimal grid (minimal placeholders)
        for (let i = actualCameraCount; i < optimalGridSize; i++) {
            const placeholder = this.createCameraPlaceholder(i);
            grid.appendChild(placeholder);
        }

        // Load initial images
        this.loadCameraImages();
    }

    createCameraContainer(index) {
        const container = document.createElement('div');
        container.className = 'camera-container';
        container.id = `camera-${index}`;
        container.tabIndex = 0;

        container.innerHTML = `
            <div class="camera-loading">
                <div class="animate-spin w-8 h-8 border-2 border-gray-300 border-t-blue-600 rounded-full"></div>
                <p class="mt-2">Loading...</p>
            </div>
            <img class="camera-image hidden" alt="Camera view">
            <div class="camera-info">
                <h3 class="camera-title"></h3>
                <p class="camera-details"></p>
                <p class="camera-timestamp"></p>
                <span class="municipality-tag"></span>
            </div>
            <button class="lock-button" data-index="${index}">
                <span class="unlock-icon">🔓</span>
                <span class="lock-icon hidden">🔒</span>
            </button>
        `;

        // Add click handler for modal
        container.addEventListener('click', (e) => {
            if (!e.target.classList.contains('lock-button')) {
                this.showCameraModal(index);
            }
        });

        // Add lock button handler
        const lockButton = container.querySelector('.lock-button');
        lockButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCameraLock(index);
        });

        return container;
    }

    createCameraPlaceholder(index) {
        const placeholder = document.createElement('div');
        placeholder.className = 'camera-container camera-placeholder';
        placeholder.id = `camera-${index}`;
        placeholder.innerHTML = `
            <div class="placeholder-content">
                <div class="placeholder-icon">📷</div>
                <div>No camera available</div>
            </div>
        `;
        return placeholder;
    }

    async loadCameraImages() {
        const availableCameras = this.getFilteredCameras();
        const actualCameraCount = Math.min(this.config.cameraCount, availableCameras.length);

        for (let i = 0; i < actualCameraCount; i++) {
            if (this.lockedCameras.has(i) && this.currentImages[i]) {
                // Skip locked cameras that already have images
                continue;
            }

            const cameraIndex = (this.currentCycleIndex + i) % availableCameras.length;
            const camera = availableCameras[cameraIndex];

            if (camera) {
                await this.loadSingleCamera(i, camera);
            }
        }
    }

    async loadSingleCamera(containerIndex, camera) {
        const container = document.getElementById(`camera-${containerIndex}`);
        if (!container || container.classList.contains('camera-placeholder')) {
            return;
        }

        const img = container.querySelector('.camera-image');
        const loading = container.querySelector('.camera-loading');
        const info = container.querySelector('.camera-info');

        try {
            // Show loading state
            loading.classList.remove('hidden');
            img.classList.add('hidden');

            // Load image
            await this.loadImage(img, camera.imageUrl);

            // Update info
            this.updateCameraInfo(container, camera);

            // Show image
            loading.classList.add('hidden');
            img.classList.remove('hidden');

            // Store current image data
            this.currentImages[containerIndex] = camera;

        } catch (error) {
            console.error('Error loading camera image:', error);
            this.showCameraError(container, 'Failed to load image');
        }
    }

    loadImage(img, url) {
        return new Promise((resolve, reject) => {
            const newImg = new Image();
            newImg.onload = () => {
                img.src = url;
                img.alt = 'Camera view';
                resolve();
            };
            newImg.onerror = reject;
            newImg.src = url;
        });
    }

    updateCameraInfo(container, camera) {
        const title = container.querySelector('.camera-title');
        const details = container.querySelector('.camera-details');
        const timestamp = container.querySelector('.camera-timestamp');
        const municipalityTag = container.querySelector('.municipality-tag');

        title.textContent = camera.presentationName || 'Camera';
        details.textContent = camera.stationName.replace(/_/g, ' ');
        timestamp.textContent = camera.age;
        municipalityTag.textContent = camera.municipality;
    }

    showCameraError(container, message) {
        container.innerHTML = `
            <div class="camera-error">
                <svg class="bc-w-8 bc-h-8 bc-mb-2" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"></path>
                </svg>
                <p>${message}</p>
            </div>
        `;
    }

    showNoCamerasMessage() {
        const grid = document.getElementById('cameraGrid');
        grid.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-20">
                <svg class="w-16 h-16 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                </svg>
                <h3 class="text-xl text-gray-400 mb-2">No cameras available</h3>
                <p class="text-gray-500 text-center">
                    No cameras match your current filters.<br>
                    Try adjusting your settings or check back later.
                </p>
            </div>
        `;
    }

    showCameraModal(containerIndex) {
        const container = document.getElementById(`camera-${containerIndex}`);
        
        // Don't show modal for placeholders
        if (!container || container.classList.contains('camera-placeholder')) {
            return;
        }
        
        const camera = this.currentImages[containerIndex];
        if (!camera) return;

        const modal = document.getElementById('cameraModal');
        const title = document.getElementById('modalTitle');
        const image = document.getElementById('modalImage');
        const info = document.getElementById('modalInfo');

        title.textContent = `${camera.presentationName} - ${camera.stationName.replace(/_/g, ' ')}`;
        image.src = camera.imageUrl;
        image.alt = camera.presentationName;

        info.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                    <strong>Municipality:</strong> ${camera.municipality}<br>
                    <strong>Station:</strong> ${camera.stationName.replace(/_/g, ' ')}<br>
                    <strong>Camera ID:</strong> ${camera.cameraId}
                </div>
                <div>
                    <strong>Last Updated:</strong> ${camera.age}<br>
                    <strong>Coordinates:</strong> ${camera.lat.toFixed(4)}, ${camera.lon.toFixed(4)}<br>
                    <strong>Preset ID:</strong> ${camera.presetId}
                </div>
            </div>
        `;

        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }

    toggleCameraLock(index) {
        const container = document.getElementById(`camera-${index}`);
        
        // Don't allow locking placeholders
        if (!container || container.classList.contains('camera-placeholder')) {
            return;
        }
        
        const lockButton = container.querySelector('.lock-button');
        const unlockIcon = lockButton.querySelector('.unlock-icon');
        const lockIcon = lockButton.querySelector('.lock-icon');

        if (this.lockedCameras.has(index)) {
            // Unlock
            this.lockedCameras.delete(index);
            container.classList.remove('locked');
            unlockIcon.classList.remove('hidden');
            lockIcon.classList.add('hidden');
            lockButton.classList.remove('locked');
        } else {
            // Lock
            this.lockedCameras.add(index);
            container.classList.add('locked');
            unlockIcon.classList.add('hidden');
            lockIcon.classList.remove('hidden');
            lockButton.classList.add('locked');
        }
    }

    startCycling() {
        this.stopCycling();
        this.config.cycling = true;

        this.cyclingInterval = setInterval(() => {
            this.cycleCameras();
        }, this.config.cyclingInterval);

        this.updateCyclingButton();
        console.log(`Started cycling with ${this.config.cyclingInterval}ms interval`);
    }

    stopCycling() {
        this.config.cycling = false;
        if (this.cyclingInterval) {
            clearInterval(this.cyclingInterval);
            this.cyclingInterval = null;
        }
        this.updateCyclingButton();
        console.log('Stopped cycling');
    }

    cycleCameras() {
        const availableCameras = this.getFilteredCameras();
        if (availableCameras.length === 0) return;

        // Move to next set of cameras
        this.currentCycleIndex = (this.currentCycleIndex + this.config.cameraCount) % availableCameras.length;

        // Load new images for unlocked cameras
        this.loadCameraImages();

        // Add cycling animation
        const grid = document.getElementById('cameraGrid');
        grid.classList.add('camera-cycling');
        setTimeout(() => grid.classList.remove('camera-cycling'), 1000);
    }

    updateCyclingButton() {
        const button = document.getElementById('cyclingToggle');
        const status = document.getElementById('cyclingStatus');

        if (this.config.cycling) {
            button.classList.remove('btn-success');
            button.classList.add('btn-danger');
            status.textContent = 'Stop';
        } else {
            button.classList.remove('btn-danger');
            button.classList.add('btn-success');
            status.textContent = 'Start';
        }
    }

    async updateCameraImages() {
        this.showLoadingIndicator(true);

        try {
            // Reload current images with fresh data
            for (let i = 0; i < this.config.cameraCount; i++) {
                const container = document.getElementById(`camera-${i}`);
                
                // Skip if container doesn't exist or is a placeholder
                if (!container || container.classList.contains('camera-placeholder')) {
                    continue;
                }
                
                const currentCamera = this.currentImages[i];
                if (currentCamera && !this.lockedCameras.has(i)) {
                    // Find the same camera in current data and reload
                    const updatedCamera = this.cameras.find(c =>
                        c.presetId === currentCamera.presetId
                    );
                    if (updatedCamera) {
                        await this.loadSingleCamera(i, updatedCamera);
                    }
                }
            }

            this.updateStatus('Images updated', 'success');
        } catch (error) {
            console.error('Error updating images:', error);
            this.updateStatus('Update failed', 'error');
        } finally {
            this.showLoadingIndicator(false);
        }
    }

    startPeriodicUpdates() {
        // Update images every minute
        setInterval(() => {
            this.updateCameraImages();
        }, 60000);

        // Full camera reload every 30 minutes
        setInterval(() => {
            this.loadCameras();
        }, 30 * 60000);
    }

    setupEventListeners() {
        // Camera count - Regular select
        document.getElementById('cameraCount').addEventListener('change', (e) => {
            this.config.cameraCount = parseInt(e.target.value);
            this.updateCycleTimeOptions(); // Update available cycle times
            this.renderCameras();
        });

        // Cycling controls
        document.getElementById('cyclingToggle').addEventListener('click', () => {
            if (this.config.cycling) {
                this.stopCycling();
            } else {
                this.startCycling();
            }
        });

        // Cycling interval - Regular select  
        document.getElementById('cyclingInterval').addEventListener('change', (e) => {
            this.config.cyclingInterval = parseInt(e.target.value);
            if (this.config.cycling) {
                this.startCycling(); // Restart with new interval
            }
        });

        // Cycling mode - Regular select
        document.getElementById('cyclingMode').addEventListener('change', (e) => {
            this.config.cyclingMode = e.target.value;
            this.updateModeSelectors();
            this.renderCameras();
        });

        // Municipality selector - Regular select
        document.getElementById('selectedMunicipality').addEventListener('change', (e) => {
            this.config.selectedMunicipality = e.target.value;
            this.renderCameras();
        });

        // Station selector - Regular select
        document.getElementById('selectedStation').addEventListener('change', (e) => {
            this.config.selectedStation = e.target.value;
            this.renderCameras();
        });

        // Filters
        document.getElementById('dropOldCameras').addEventListener('change', (e) => {
            this.config.dropOldCameras = e.target.checked;
            // Re-filter from original unfiltered cameras
            this.cameras = this.filterCameras(this.allCameras);
            this.renderCameras();
        });

        document.getElementById('autoHideControls').addEventListener('change', (e) => {
            this.config.autoHideControls = e.target.checked;
            if (e.target.checked) {
                this.setupAutoHide();
            } else {
                this.clearHideTimer();
            }
        });

        // Modal controls
        document.getElementById('closeModal').addEventListener('click', () => {
            this.closeModal();
        });

        document.getElementById('cameraModal').addEventListener('click', (e) => {
            if (e.target.classList.contains('modal') || e.target.classList.contains('modal-overlay')) {
                this.closeModal();
            }
        });

        // Keyboard controls
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
            }
        });

        // Handle window resize for mobile detection
        window.addEventListener('resize', () => {
            const wasMobile = this.isMobile;
            this.isMobile = this.detectMobile();
            
            // If mobile state changed, reapply restrictions
            if (wasMobile !== this.isMobile) {
                this.setupMobileRestrictions();
                this.renderCameras();
            }
        });
    }

    // Setup mobile-specific restrictions
    setupMobileRestrictions() {
        if (!this.isMobile) return;

        const cameraCountSelect = document.getElementById('cameraCount');
        const options = cameraCountSelect.querySelectorAll('option');
        
        // Hide options for more than 8 cameras on mobile
        options.forEach(option => {
            const value = parseInt(option.value);
            if (value > 8) {
                option.classList.add('mobile-hidden');
                option.style.display = 'none';
            }
        });

        // If current selection is > 8, reset to 8
        if (this.config.cameraCount > 8) {
            this.config.cameraCount = 8;
            cameraCountSelect.value = '8';
            this.renderCameras();
        }

        console.log('Mobile restrictions applied: max 8 cameras');
    }

    updateModeSelectors() {
        const municipalitySelector = document.getElementById('municipalitySelector');
        const stationSelector = document.getElementById('stationSelector');

        municipalitySelector.classList.add('hidden');
        stationSelector.classList.add('hidden');

        if (this.config.cyclingMode === 'municipality') {
            municipalitySelector.classList.remove('hidden');
        } else if (this.config.cyclingMode === 'station') {
            stationSelector.classList.remove('hidden');
        }
    }

    setupAutoHide() {
        if (!this.config.autoHideControls) return;

        const elements = [
            document.getElementById('settings-popover-content'),
            document.getElementById('settingsToggle')
        ];

        elements.forEach(element => {
            if (element) {
                element.addEventListener('mouseenter', () => this.clearHideTimer());
                element.addEventListener('mouseleave', () => this.resetHideTimer());
            }
        });

        // Track all user interactions
        const interactionEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'touchmove'];
        interactionEvents.forEach(event => {
            document.addEventListener(event, () => {
                this.showUI();
                this.resetHideTimer();
            }, { passive: true });
        });

        // Initial hide timer
        this.resetHideTimer();
    }

    showUI() {
        if (this.uiHidden) {
            const settingsOverlay = document.getElementById('settingsOverlay');
            const statusOverlay = document.getElementById('statusOverlay');

            if (settingsOverlay) settingsOverlay.classList.remove('hidden-ui');
            if (statusOverlay) statusOverlay.classList.remove('hidden-ui');

            this.uiHidden = false;
        }
    }

    hideUI() {
        if (!this.uiHidden) {
            const settingsOverlay = document.getElementById('settingsOverlay');
            const statusOverlay = document.getElementById('statusOverlay');

            // Don't hide if popover is open
            const trigger = document.getElementById('settingsToggle');
            const isPopoverOpen = trigger && trigger.getAttribute('aria-expanded') === 'true';

            if (!isPopoverOpen) {
                if (settingsOverlay) settingsOverlay.classList.add('hidden-ui');
                if (statusOverlay) statusOverlay.classList.add('hidden-ui');

                this.uiHidden = true;
            }
        }
    }

    updateCycleTimeOptions() {
        const cameraCount = this.config.cameraCount;
        const intervalSelect = document.getElementById('cyclingInterval');
        const warningDiv = document.getElementById('rateLimitWarning');

        // Define minimum cycle times based on camera count to prevent API rate limiting
        const minCycleTimes = {
            1: 2000,   // 1 camera: 2s min
            2: 3000,   // 2 cameras: 3s min  
            4: 5000,   // 4 cameras: 5s min
            6: 8000,   // 6 cameras: 8s min
            8: 10000,  // 8 cameras: 10s min
            12: 15000, // 12 cameras: 15s min
            16: 20000  // 16 cameras: 20s min (as requested)
        };

        const minTime = minCycleTimes[cameraCount] || 10000;
        const currentValue = parseInt(intervalSelect.value);

        // Update options based on minimum time
        const options = intervalSelect.querySelectorAll('option');
        options.forEach(option => {
            const value = parseInt(option.value);
            if (value < minTime) {
                option.disabled = true;
                option.style.color = '#9ca3af';
            } else {
                option.disabled = false;
                option.style.color = '';
            }
        });

        // Show warning if current selection is too fast
        if (currentValue < minTime) {
            warningDiv.classList.remove('hidden');
            // Auto-select minimum allowed time
            intervalSelect.value = minTime.toString();
            this.config.cyclingInterval = minTime;
        } else {
            warningDiv.classList.add('hidden');
        }
    }

    resetHideTimer() {
        if (!this.config.autoHideControls) return;

        this.clearHideTimer();
        this.hideControlsTimer = setTimeout(() => {
            this.hideUI();
        }, this.config.hideTimeout);
    }

    clearHideTimer() {
        if (this.hideControlsTimer) {
            clearTimeout(this.hideControlsTimer);
            this.hideControlsTimer = null;
        }
    }

    closeModal() {
        const modal = document.getElementById('cameraModal');
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }

    updateStatus(message, type = 'info') {
        const statusText = document.getElementById('statusText');
        const lastUpdate = document.getElementById('lastUpdate');

        statusText.textContent = message;
        statusText.className = `status-${type}`;

        if (this.lastFullUpdate) {
            lastUpdate.textContent = `Last updated: ${this.lastFullUpdate.toLocaleTimeString()}`;
        }
    }

    showLoadingIndicator(show) {
        const indicator = document.getElementById('loadingIndicator');
        if (show) {
            indicator.classList.remove('hidden');
        } else {
            indicator.classList.add('hidden');
        }
    }

    /**
     * Start periodic image refresh (every minute)
     * This ensures images don't go stale while keeping the same cameras displayed
     */
    startImageRefresh() {
        console.log('Starting image refresh timer (60 seconds)');

        this.imageRefreshInterval = setInterval(() => {
            if (this.currentImages.length > 0) {
                console.log('Refreshing camera images...');
                this.refreshCurrentImages();
            }
        }, 60000); // 60 seconds = 1 minute
    }

    /**
     * Refresh the images of currently displayed cameras
     */
    refreshCurrentImages() {
        const cameraGrid = document.getElementById('cameraGrid');
        if (!cameraGrid) return;

        const containers = cameraGrid.querySelectorAll('.camera-container');
        let refreshCount = 0;

        containers.forEach((container, index) => {
            const img = container.querySelector('img');
            const cameraData = this.currentImages[index];

            if (img && cameraData && cameraData.presets && cameraData.presets.length > 0) {
                // Add timestamp to prevent caching
                const imageUrl = cameraData.presets[0].imageUrl + '?t=' + Date.now();

                // Create a new image to test if it loads
                const testImg = new Image();
                testImg.onload = () => {
                    img.src = imageUrl;
                    refreshCount++;

                    // Update the timestamp overlay if it exists
                    const timestamp = container.querySelector('.camera-timestamp');
                    if (timestamp) {
                        timestamp.textContent = new Date().toLocaleTimeString();
                    }
                };

                testImg.onerror = () => {
                    console.warn(`Failed to refresh image for camera ${cameraData.id}`);
                };

                testImg.src = imageUrl;
            }
        });

        if (refreshCount > 0) {
            console.log(`Refreshed ${refreshCount} camera images`);
            // Update the last update timestamp
            const lastUpdate = document.getElementById('lastUpdate');
            if (lastUpdate) {
                lastUpdate.textContent = `Images refreshed: ${new Date().toLocaleTimeString()}`;
            }
        }
    }

    /**
     * Stop image refresh timer
     */
    stopImageRefresh() {
        if (this.imageRefreshInterval) {
            clearInterval(this.imageRefreshInterval);
            this.imageRefreshInterval = null;
            console.log('Stopped image refresh timer');
        }
    }
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.oulunWebCams = new OuluWebCams();
});
