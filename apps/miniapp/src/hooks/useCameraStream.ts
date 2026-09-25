import { useCallback, useEffect, useRef, useState } from 'react'

type CameraState = 'idle' | 'loading' | 'ready' | 'error'

export function useCameraStream() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [state, setState] = useState<CameraState>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [retryTrigger, setRetryTrigger] = useState(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    let currentStream: MediaStream | null = null

    const startCamera = async () => {
      setState('loading')

      if (!navigator.mediaDevices?.getUserMedia) {
        setState('error')
        setErrorMessage('Camera is not available on this device.')
        return
      }

      let attempts = 0
      while (!videoRef.current && attempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }

      if (!videoRef.current) {
        setState('error')
        setErrorMessage('Unable to initialize camera. Please try again.')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          },
          audio: false,
        })

        if (!mountedRef.current) {
          stream.getTracks().forEach(track => track.stop())
          return
        }

        currentStream = stream
        streamRef.current = stream

        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          video.setAttribute('playsinline', 'true')
          video.setAttribute('muted', 'true')
          video.setAttribute('autoplay', 'true')

          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              if (video.readyState >= 2) {
                resolve()
              } else {
                reject(new Error('Video load timeout'))
              }
            }, 10000)

            const handleLoadedMetadata = () => {
              clearTimeout(timeout)
              video.removeEventListener('loadedmetadata', handleLoadedMetadata)
              resolve()
            }

            if (video.readyState >= 2) {
              clearTimeout(timeout)
              resolve()
            } else {
              video.addEventListener('loadedmetadata', handleLoadedMetadata)
              video.load()
            }
          })

          if (!mountedRef.current) return

          try {
            await video.play()
          } catch {
            // Autoplay can be refused while the preview still renders frames,
            // so the scanner is usable either way.
          }
          setState('ready')
        }
      } catch (error) {
        if (!mountedRef.current) return

        setState('error')
        const err = error as Error
        if (err.name === 'NotAllowedError') {
          setErrorMessage('Camera permission denied. Please allow camera access.')
        } else if (err.name === 'NotFoundError') {
          setErrorMessage('No camera found on this device.')
        } else {
          setErrorMessage('Unable to access camera. Please try again.')
        }
      }
    }

    void startCamera()

    return () => {
      mountedRef.current = false
      if (currentStream) {
        currentStream.getTracks().forEach((track) => track.stop())
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
    }
  }, [retryTrigger])

  const retry = useCallback(() => {
    setRetryTrigger(prev => prev + 1)
  }, [])

  return {
    videoRef,
    state,
    errorMessage,
    retry,
  }
}

