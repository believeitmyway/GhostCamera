let videoStream = null;
let currentDeviceId = null;
let currentEffect = 'eye-swap';
let faceMesh = null;
let camera = null;
let canvasCtx = null;
let outputCanvas = null;
let videoElement = null;
let isDrawing = false;
let animationFrameId = null;
let lastResults = null;

document.addEventListener('DOMContentLoaded', () => {
  videoElement = document.getElementById('videoElement');
  outputCanvas = document.getElementById('outputCanvas');
  canvasCtx = outputCanvas.getContext('2d');

  const settingsBtn = document.getElementById('settingsBtn');
  const shutterBtn = document.getElementById('shutterBtn');
  const settingsModal = document.getElementById('settingsModal');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const effectSelect = document.getElementById('effectSelect');
  const cameraSelect = document.getElementById('cameraSelect');

  settingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  effectSelect.addEventListener('change', (e) => {
    currentEffect = e.target.value;
  });

  cameraSelect.addEventListener('change', (e) => {
    startCamera(e.target.value);
  });

  shutterBtn.addEventListener('click', captureAndDownload);

  window.addEventListener('resize', resizeCanvas);

  initFaceMesh();
  initCamera();
});

function resizeCanvas() {
  if (outputCanvas) {
    outputCanvas.width = window.innerWidth;
    outputCanvas.height = window.innerHeight;
  }
}

function initFaceMesh() {
  faceMesh = new FaceMesh({locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
  }});

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true, // Needed for iris/eyes
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  faceMesh.onResults(onResults);
}

async function initCamera() {
  try {
    // Request initial permission
    await navigator.mediaDevices.getUserMedia({ video: true });

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');

    const cameraSelect = document.getElementById('cameraSelect');
    cameraSelect.innerHTML = '';

    let defaultDeviceId = null;
    let backCameraFound = false;

    videoDevices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `カメラ ${index + 1}`;
      cameraSelect.appendChild(option);

      const label = device.label.toLowerCase();
      if (!backCameraFound && (label.includes('back') || label.includes('rear') || label.includes('背面'))) {
        defaultDeviceId = device.deviceId;
        backCameraFound = true;
      }
    });

    if (!defaultDeviceId && videoDevices.length > 0) {
      defaultDeviceId = videoDevices[0].deviceId;
    }

    if (defaultDeviceId) {
      cameraSelect.value = defaultDeviceId;
      await startCamera(defaultDeviceId);
    }
  } catch (error) {
    console.error('Error initializing camera:', error);
    alert('カメラの初期化に失敗しました。');
  }
}

async function startCamera(deviceId) {
  if (camera) {
    camera.stop();
  }
  if (videoElement && videoElement.srcObject) {
    videoElement.srcObject.getTracks().forEach(track => track.stop());
  }
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }

  currentDeviceId = deviceId;

  const constraints = {
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "environment" // Attempt back camera by default if deviceId isn't perfect
    }
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = stream;

    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play();
        resolve();
      };
    });

    resizeCanvas();

    // Use MediaPipe's Camera utility to continuously send frames
    camera = new Camera(videoElement, {
      onFrame: async () => {
        await faceMesh.send({image: videoElement});
      },
      width: 1280,
      height: 720
    });

    camera.start();

    // Start our own render loop for drawing canvas
    renderLoop();

  } catch (error) {
    console.error('Error starting camera:', error);
    // If exact deviceId fails, fallback to simple environmental request
    fallbackCamera();
  }
}

async function fallbackCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        videoElement.srcObject = stream;
        videoElement.play();
        resizeCanvas();
        camera = new Camera(videoElement, {
          onFrame: async () => {
            await faceMesh.send({image: videoElement});
          },
          width: 1280,
          height: 720
        });
        camera.start();
        renderLoop();
    } catch (e) {
        console.error("Fallback camera failed:", e);
    }
}

function onResults(results) {
  lastResults = results;
}

function renderLoop() {
  drawFrame();
  animationFrameId = requestAnimationFrame(renderLoop);
}

function drawFrame() {
  if (!canvasCtx || !outputCanvas || !videoElement || videoElement.readyState < 2) return;

  const width = outputCanvas.width;
  const height = outputCanvas.height;

  // Clear canvas
  canvasCtx.clearRect(0, 0, width, height);

  // Calculate scaling to fill the screen (object-fit: cover equivalent in canvas)
  const videoAspect = videoElement.videoWidth / videoElement.videoHeight;
  const canvasAspect = width / height;

  let drawWidth, drawHeight, startX, startY;

  if (canvasAspect > videoAspect) {
    // Canvas is wider than video
    drawWidth = width;
    drawHeight = width / videoAspect;
    startX = 0;
    startY = (height - drawHeight) / 2;
  } else {
    // Canvas is taller than video
    drawHeight = height;
    drawWidth = height * videoAspect;
    startX = (width - drawWidth) / 2;
    startY = 0;
  }

  // Draw the base video frame
  // Note: we might need to mirror the video if it's the front camera
  // For now, we draw it as-is.
  canvasCtx.drawImage(videoElement, startX, startY, drawWidth, drawHeight);

  // Apply effect
  if (currentEffect === 'eye-swap' && lastResults && lastResults.multiFaceLandmarks && lastResults.multiFaceLandmarks.length > 0) {
    applyGhostEffect(lastResults.multiFaceLandmarks[0], startX, startY, drawWidth, drawHeight, videoElement.videoWidth, videoElement.videoHeight);
  }
}

function applyGhostEffect(landmarks, startX, startY, drawWidth, drawHeight, videoWidth, videoHeight) {
  // Define eye centers based on landmarks. These points are approximate centers
  const leftEyeIdx = 468;  // Center of left eye (iris)
  const rightEyeIdx = 473; // Center of right eye (iris)

  const leftEyePt = landmarks[leftEyeIdx];
  const rightEyePt = landmarks[rightEyeIdx];

  if (!leftEyePt || !rightEyePt) return;

  // Calculate coordinates relative to the canvas based on object-fit: cover logic
  const leftX = startX + leftEyePt.x * drawWidth;
  const leftY = startY + leftEyePt.y * drawHeight;

  const rightX = startX + rightEyePt.x * drawWidth;
  const rightY = startY + rightEyePt.y * drawHeight;

  // Approximate eye radius (distance between inner and outer corners or simply a fixed size based on face width)
  // Let's use distance between the two eyes to scale the radius dynamically
  const eyeDistance = Math.sqrt(Math.pow(rightX - leftX, 2) + Math.pow(rightY - leftY, 2));
  const radius = eyeDistance * 0.35; // Adjust this multiplier for a better fit

  // Since we are extracting from the main canvas itself, doing it sequentially overwrites the second eye.
  // We need to extract BOTH eyes first before drawing them to their new locations.

  function extractEye(sourceX, sourceY, r) {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = r * 2;
    offCanvas.height = r * 2;
    const offCtx = offCanvas.getContext('2d');

    const sx = sourceX - r;
    const sy = sourceY - r;

    // Extract the square patch
    offCtx.drawImage(outputCanvas, sx, sy, r * 2, r * 2, 0, 0, r * 2, r * 2);

    // Apply radial gradient mask
    offCtx.globalCompositeOperation = 'destination-in';
    const gradient = offCtx.createRadialGradient(r, r, 0, r, r, r);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
    gradient.addColorStop(0.6, 'rgba(0, 0, 0, 1)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    offCtx.fillStyle = gradient;
    offCtx.beginPath();
    offCtx.arc(r, r, r, 0, Math.PI * 2);
    offCtx.fill();

    return offCanvas;
  }

  // 1. Extract both
  const leftEyeCanvas = extractEye(leftX, leftY, radius);
  const rightEyeCanvas = extractEye(rightX, rightY, radius);

  // 2. Draw them swapped
  canvasCtx.save();

  // Draw left eye on right location, mirrored horizontally for extra creepiness
  canvasCtx.translate(rightX, rightY);
  canvasCtx.scale(-1, 1);
  canvasCtx.drawImage(leftEyeCanvas, -radius, -radius);

  canvasCtx.restore();

  canvasCtx.save();

  // Draw right eye on left location, mirrored horizontally
  canvasCtx.translate(leftX, leftY);
  canvasCtx.scale(-1, 1);
  canvasCtx.drawImage(rightEyeCanvas, -radius, -radius);

  canvasCtx.restore();
}

function captureAndDownload() {
  if (!outputCanvas) return;

  // Play shutter sound or flash effect (optional, here we just flash the screen)
  const flash = document.createElement('div');
  flash.style.position = 'absolute';
  flash.style.top = '0';
  flash.style.left = '0';
  flash.style.width = '100vw';
  flash.style.height = '100vh';
  flash.style.backgroundColor = 'white';
  flash.style.zIndex = '9999';
  flash.style.opacity = '1';
  flash.style.transition = 'opacity 0.3s';
  flash.style.pointerEvents = 'none';
  document.body.appendChild(flash);

  // Trigger reflow
  flash.offsetWidth;
  flash.style.opacity = '0';

  setTimeout(() => {
    if (document.body.contains(flash)) {
      document.body.removeChild(flash);
    }
  }, 300);

  // Convert canvas to data URL
  const dataURL = outputCanvas.toDataURL('image/png');

  // Create download link
  const a = document.createElement('a');
  a.href = dataURL;
  a.download = `ar_camera_${new Date().getTime()}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
