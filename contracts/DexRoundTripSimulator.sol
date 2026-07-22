// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Simulation {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV2RouterSimulation {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice Executed only through eth_call with code/state overrides. Never deployed.
contract DexRoundTripSimulator {
    error ApprovalFailed(address token);
    error BuyReturnedZero();
    error SellReturnedZero();

    function simulate(address router, address base, address token, uint256 amountIn)
        external
        returns (uint256 bought, uint256 baseReturned)
    {
        IERC20Simulation baseToken = IERC20Simulation(base);
        IERC20Simulation targetToken = IERC20Simulation(token);
        if (!baseToken.approve(router, amountIn)) revert ApprovalFailed(base);

        address[] memory buyPath = new address[](2);
        buyPath[0] = base;
        buyPath[1] = token;
        IUniswapV2RouterSimulation(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn, 0, buyPath, address(this), block.timestamp + 60
        );

        bought = targetToken.balanceOf(address(this));
        if (bought == 0) revert BuyReturnedZero();
        if (!targetToken.approve(router, bought)) revert ApprovalFailed(token);

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = base;
        IUniswapV2RouterSimulation(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            bought, 0, sellPath, address(this), block.timestamp + 60
        );

        baseReturned = baseToken.balanceOf(address(this));
        if (baseReturned == 0) revert SellReturnedZero();
    }
}
