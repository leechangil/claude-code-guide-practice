from ex_pipeline import add


def test_add_integers() -> None:
    assert add(1, 2) == 3


def test_add_floats() -> None:
    assert add(1.5, 2.5) == 4.0


def test_add_negative() -> None:
    assert add(-1, 1) == 0


def test_add_zero() -> None:
    assert add(0, 0) == 0


def test_add_mixed() -> None:
    assert add(1, 2.5) == 3.5
