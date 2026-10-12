"""Start the Processing worker from the command line.

Application startup is imported inside main() so spawned calculation processes
can import this module without starting another worker.
"""

def main() -> None:
    """Load worker configuration and run the Processing job loop.

    Multiprocessing reimports this module when it spawns a native child. Keeping
    application imports inside this function lets the child load only its native
    operation modules. Worker startup, reset and shutdown remain owned by the
    existing composition function.

    Raises:
        ValueError: If worker configuration or source paths are invalid.
    """
    import asyncio
    from contextlib import suppress
    import logging

    from eolab_app.main import run_processing_worker

    logging.basicConfig(level=logging.INFO)
    with suppress(asyncio.CancelledError, KeyboardInterrupt):
        asyncio.run(run_processing_worker())


if __name__ == "__main__":
    main()
